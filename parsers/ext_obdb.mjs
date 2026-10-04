#!/usr/bin/env node
// ext_obdb.mjs — external live-data scaling layer from the OBDb community project.
// Zero-dependency Node ESM (Node v22). By default copies the committed snapshot
// external/obdb/obd_signal.ndjson (no network, reproducible). With --refresh it fetches the BMW signalset
// JSON over HTTPS from unpinned upstream branches, flattens it into one NDJSON row per signal, and
// rewrites the snapshot.
//
// SOURCE: OBDb — https://github.com/OBDb  (org of per-model repos: OBDb/BMW-*)
// LICENSE: CC-BY-SA-4.0  (attribution + share-alike; recorded in external/obdb/SOURCE.md)
//
// This fills the live-data scaling gap in the unified DB with OPEN data: OBDb signal
// definitions carry the raw->engineering decode (bit offset/length, divisor/multiplier,
// additive offset, sign, unit) plus value enum maps for status signals — exactly what
// the BMW/EDIABAS-derived layers do NOT publish openly.
//
// ── OBDb v3 signalset schema (verified by inspection of OBDb/BMW, BMW-3-Series, BMW-i3)
// File: signalsets/v3/default.json
//   { "commands": [ COMMAND, ... ] }
// COMMAND:
//   hdr   : request CAN header (hex string, e.g. "6F1")           — tester→ECU
//   rax   : response CAN address / ECU header (hex string, "607") — ECU→tester  (the ECU we record)
//   eax   : extended-addressing ECU byte (hex string, "07")       — ECU id on the K/D-CAN bus
//   cmd   : { "<service>": "<payload>" }  e.g. {"22":"DD68"}  → UDS svc 0x22 (RDBI), DID 0xDD68
//   freq  : poll frequency hint (Hz-ish) — not part of the scaling, ignored
//   signals : [ SIGNAL, ... ]
// SIGNAL:
//   id    : stable signal id (e.g. "BMW_HVBAT_V")
//   name  : human label
//   path  : UI grouping ("Battery", "Movement", ...) — kept as a hint
//   fmt   : decode formula:
//     bix  : bit offset into the response payload (default 0)
//     len  : bit length
//     div  : divisor   (scale = mul/div)
//     mul  : multiplier (scale = mul/div)
//     add  : additive offset (engineering = raw*scale + add)
//     sign : true => two's-complement signed
//     min/max : engineering-range clamps (carried through)
//     unit : engineering unit token ("volts","celsius",...)
//     omix : optional output bit mask — recorded inside values json if present
//     map  : { "<raw>": { "value": "ENUM", "description": "text" }, ... }  enum table
//
// Engineering value = raw * (mul/div) + add   (mul,div default 1; add defaults 0)
//
// Output: build/external/obd_signal.ndjson — one row per signal:
//   { make, model, chassis_hint, ecu_header, did_or_pid, name, unit, scale, offset,
//     bit_offset, bit_length, signed, values(json|null), source_repo }
//
// Join conventions (universal): chassis tokens UPPERCASE; hex values 0x-prefixed.
//   ecu_header  : 0x-prefixed uppercase hex (from rax, else hdr)
//   did_or_pid  : 0x-prefixed uppercase hex of the service+payload (e.g. "0x22DD68")
//   chassis_hint: UPPERCASE chassis code when the repo name IS a chassis (E91/E92/F34),
//                 else null (model-named repos like "BMW-3-Series" are not a single chassis).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'build', 'external');
const OUT_FILE = path.join(OUT_DIR, 'obd_signal.ndjson');

const ORG = 'OBDb';
const SIGNALSET_PATH = 'signalsets/v3/default.json';

// Known BMW repos in the OBDb org (fallback if the GitHub API listing is unreachable).
// Verified present 2026-06 via `GET /search/repositories?q=org:OBDb+BMW+in:name`.
const FALLBACK_REPOS = [
  'BMW', 'BMW-1-Series', 'BMW-2-Series', 'BMW-2-Grand-Coupe', 'BMW-3-Series',
  'BMW-3-Series-eDrive', 'BMW-4-Series', 'BMW-5-Series', 'BMW-5-Series-xDrive',
  'BMW-7-Series', 'BMW-116i', 'BMW-230e', 'BMW-330e', 'BMW-640i-f13', 'BMW-840i',
  'BMW-E91', 'BMW-E92', 'BMW-F34', 'BMW-M2', 'BMW-M3', 'BMW-M4', 'BMW-M5', 'BMW-M440i',
  'BMW-X1', 'BMW-X2', 'BMW-X3', 'BMW-X4', 'BMW-X5', 'BMW-X7', 'BMW-Z3', 'BMW-Z4',
  'BMW-i3', 'BMW-i3s', 'BMW-i4', 'BMW-i5', 'BMW-i8', 'BMW-iX', 'BMW-iX3',
];

// Chassis-coded repo names: when the repo IS a chassis token, carry it as chassis_hint.
// Model/marketing names (3-Series, M3, 330e, ...) are NOT a single chassis -> null.
const CHASSIS_RE = /^(E\d{2,3}|F\d{2,3}|G\d{2,3}|U\d{2,3}|I\d{2}|RR\d{1,2})$/i;

// ---------------------------------------------------------------------------
// tiny HTTPS GET via fetch (Node 22 has global fetch); returns {ok,status,text}
// ---------------------------------------------------------------------------
async function httpGet(url, asJson = false) {
  const headers = { 'User-Agent': 'bmw-unified-db/ext_obdb (+OBDb importer)' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (asJson) headers.Accept = 'application/vnd.github+json';
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) };
  }
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// Discover BMW-* repos from the GitHub org via the listing API (paginated).
async function discoverRepos(log) {
  const names = new Set();
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/orgs/${ORG}/repos?per_page=100&page=${page}&type=public`;
    const r = await httpGet(url, true);
    if (!r.ok) {
      log(`repo-list page ${page} HTTP ${r.status}${r.error ? ' ' + r.error : ''}`);
      break;
    }
    let arr;
    try { arr = JSON.parse(r.text); } catch { break; }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const repo of arr) {
      if (repo && typeof repo.name === 'string' && /^BMW/i.test(repo.name)) names.add(repo.name);
    }
    if (arr.length < 100) break;
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// scaling helpers
// ---------------------------------------------------------------------------

// Compose scale (mul/div) and offset (add) into numbers; null when absent so the
// consumer can tell "not specified" from "explicitly 1.0 / 0.0".
function deriveScaleOffset(fmt) {
  const hasMul = fmt.mul !== undefined && fmt.mul !== null;
  const hasDiv = fmt.div !== undefined && fmt.div !== null;
  let scale = null;
  if (hasMul || hasDiv) {
    const mul = hasMul ? Number(fmt.mul) : 1;
    const div = hasDiv ? Number(fmt.div) : 1;
    scale = div !== 0 ? mul / div : null;
  }
  const offset = (fmt.add !== undefined && fmt.add !== null) ? Number(fmt.add) : null;
  return { scale, offset };
}

// Normalize the enum/value map into a compact JSON object: { "<raw>": "ENUM" }
// keeping the human description alongside. null when there is no map.
function deriveValues(fmt) {
  if (!fmt.map || typeof fmt.map !== 'object') return null;
  const out = {};
  for (const [raw, v] of Object.entries(fmt.map)) {
    if (v && typeof v === 'object') {
      out[raw] = v.value !== undefined ? v.value
        : (v.description !== undefined ? v.description : v);
    } else {
      out[raw] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Hex string -> 0x-prefixed UPPERCASE, tolerating an existing 0x and stray spaces.
function hex0x(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim().replace(/^0x/i, '').toUpperCase();
  if (!t) return null;
  return '0x' + t;
}

// ECU header: prefer the response address (rax), fall back to the request header (hdr).
function ecuHeader(cmdObj) {
  return hex0x(cmdObj.rax) || hex0x(cmdObj.hdr) || null;
}

// did_or_pid: combine UDS/OBD service byte with its payload, e.g. {"22":"DD68"} -> 0x22DD68.
// Multiple service keys are rare; we take the first deterministically (sorted).
function didOrPid(cmd) {
  if (!cmd || typeof cmd !== 'object') return null;
  const keys = Object.keys(cmd).sort();
  if (!keys.length) return null;
  const svc = keys[0];
  const payload = cmd[svc];
  const svcHex = String(svc).trim().replace(/^0x/i, '').toUpperCase();
  const payHex = payload != null ? String(payload).trim().replace(/^0x/i, '').toUpperCase() : '';
  return '0x' + svcHex + payHex;
}

// Map a repo name to (model, chassis_hint).
// "BMW"            -> model null (cross-model defaults), chassis null
// "BMW-3-Series"   -> model "3-Series", chassis null
// "BMW-E91"        -> model "E91", chassis "E91"
function repoToModelChassis(repo) {
  const rest = repo.replace(/^BMW-?/i, ''); // "" | "3-Series" | "E91"
  const model = rest === '' ? null : rest;
  let chassis_hint = null;
  if (model && CHASSIS_RE.test(model)) chassis_hint = model.toUpperCase();
  return { model, chassis_hint };
}

// ---------------------------------------------------------------------------
// parse one signalset document -> emit rows
// ---------------------------------------------------------------------------
function parseSignalset(doc, repo, emit) {
  const { model, chassis_hint } = repoToModelChassis(repo);
  const commands = doc && Array.isArray(doc.commands) ? doc.commands : [];
  let nSignals = 0;
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== 'object') continue;
    const header = ecuHeader(cmd);
    const did = didOrPid(cmd.cmd);
    const signals = Array.isArray(cmd.signals) ? cmd.signals : [];
    for (const sig of signals) {
      if (!sig || typeof sig !== 'object') continue;
      const fmt = (sig.fmt && typeof sig.fmt === 'object') ? sig.fmt : {};
      const { scale, offset } = deriveScaleOffset(fmt);
      const values = deriveValues(fmt);
      const row = {
        make: 'BMW',
        model,                                   // null for the cross-model "BMW" repo
        chassis_hint,                            // UPPERCASE chassis token or null
        ecu_header: header,                      // 0x-prefixed uppercase hex
        did_or_pid: did,                         // 0x-prefixed service+payload
        name: typeof sig.name === 'string' ? sig.name : (sig.id || null),
        unit: fmt.unit !== undefined ? fmt.unit : null,
        scale,                                   // mul/div or null
        offset,                                  // add or null
        bit_offset: fmt.bix !== undefined ? Number(fmt.bix) : 0,
        bit_length: fmt.len !== undefined ? Number(fmt.len) : null,
        signed: fmt.sign === true,
        values,                                  // {raw:ENUM} json or null
        source_repo: `${ORG}/${repo}`,
      };
      emit(row);
      nSignals++;
    }
  }
  return { commands: commands.length, signals: nSignals };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// Reproducible by default: copy the committed snapshot. Pass --refresh to re-fetch from OBDb
// (unpinned upstream main branches); that also rewrites the snapshot so the change is reviewable.
const SNAPSHOT = path.join(REPO, 'external', 'obdb', 'obd_signal.ndjson');
const REFRESH = process.argv.includes('--refresh');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!REFRESH) {
    if (!fs.existsSync(SNAPSHOT)) { console.error('ext_obdb: missing snapshot ' + SNAPSHOT + ' (run with --refresh to fetch)'); process.exit(1); }
    fs.copyFileSync(SNAPSHOT, OUT_FILE);
    console.error('ext_obdb: copied committed snapshot -> ' + OUT_FILE);
    return;
  }
  const logs = [];
  const log = (m) => logs.push(m);

  // 1) discover repos (API) with fallback.
  let repos = [];
  try {
    repos = await discoverRepos(log);
  } catch (e) {
    log(`discover threw: ${e.message}`);
  }
  let discoverySource = 'github-api';
  if (repos.length === 0) {
    repos = FALLBACK_REPOS.slice();
    discoverySource = 'fallback-list';
    log('repo discovery returned 0 via API; using built-in FALLBACK_REPOS');
  } else {
    // union with fallback so a transient partial page never silently drops a model.
    const set = new Set(repos);
    for (const r of FALLBACK_REPOS) set.add(r);
    repos = [...set];
    discoverySource = 'github-api+fallback-union';
  }
  repos.sort();

  // 2) fetch + parse each signalset, streaming rows.
  const out = fs.createWriteStream(OUT_FILE, { encoding: 'utf8' });
  let totalRows = 0;
  let reposWithData = 0;
  let reposFetched = 0;
  const reposMissing = [];
  const reposError = [];
  const ecuSet = new Set();
  const unitSet = new Set();
  const perRepo = [];
  let withValues = 0;
  let withScale = 0;

  for (const repo of repos) {
    const url = `https://raw.githubusercontent.com/${ORG}/${repo}/main/${SIGNALSET_PATH}`;
    const r = await httpGet(url, false);
    if (!r.ok) {
      if (r.status === 404) reposMissing.push(repo);
      else reposError.push(`${repo} HTTP ${r.status}${r.error ? ' ' + r.error : ''}`);
      continue;
    }
    reposFetched++;
    let doc;
    try {
      doc = JSON.parse(r.text);
    } catch (e) {
      reposError.push(`${repo} JSON parse: ${e.message}`);
      continue;
    }
    let stat;
    try {
      stat = parseSignalset(doc, repo, (row) => {
        out.write(JSON.stringify(row) + '\n');
        totalRows++;
        if (row.ecu_header) ecuSet.add(row.ecu_header);
        if (row.unit) unitSet.add(row.unit);
        if (row.values) withValues++;
        if (row.scale !== null) withScale++;
      });
    } catch (e) {
      reposError.push(`${repo} parse: ${e.message}`);
      continue;
    }
    if (stat.signals > 0) reposWithData++;
    perRepo.push({ repo, commands: stat.commands, signals: stat.signals });
  }

  await new Promise((resolve, reject) => {
    out.end();
    out.on('finish', resolve);
    out.on('error', reject);
  });
  fs.copyFileSync(OUT_FILE, SNAPSHOT);   // --refresh: update the committed snapshot

  const report = {
    discoverySource,
    reposConsidered: repos.length,
    reposFetched,
    reposWithData,
    reposMissingSignalset: reposMissing.length,
    reposError: reposError.length,
    totalSignals: totalRows,
    distinctEcuHeaders: ecuSet.size,
    distinctUnits: unitSet.size,
    signalsWithEnumMap: withValues,
    signalsWithScale: withScale,
    topRepos: perRepo.sort((a, b) => b.signals - a.signals).slice(0, 12),
    sampleMissing: reposMissing.slice(0, 10),
    sampleErrors: reposError.slice(0, 10),
    logs: logs.slice(0, 12),
    outFile: OUT_FILE,
  };
  console.error(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e && e.stack || e) }));
  process.exit(1);
});
