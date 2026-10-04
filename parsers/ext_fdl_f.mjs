#!/usr/bin/env node
// BMW Unified DB — External Layer: FDL (F/G-series E-Sys FDL coding cheats)
// Zero-dependency Node ESM (Node v22). Emits streaming NDJSON:
//   build/external/fdl_code.ndjson
//     { chassis_family, ecu_or_cafd, ecu, cafd, fsw_label, value_label,
//       value_hex, meaning, group, byte_start, byte_end, mask, raw_value, series, comment, source }
//
// SOURCE (fetched repo, pinned in sources.json):
//   github.com/packetpilot/bmw-f  ->  cheats/*.xml   (GPL-3.0, see LICENSE.md in that repo)
//   The repo aggregates the community "FDL cheat code" XML files used by E-Sys launchers. We ingest the
//   WHOLE cheats/ directory (one XML per contributor), not just FDLCodes.xml. As of the pinned commit
//   that is 21 files, 96 distinct CAFDs, ~5,300 function writes, spanning F-series AND G-series
//   (G001/G005/G007/G011/G015/G020/G030, plus I001 and RR11). The mirror repo
//   botho/TokenMaster-Launcher-FDL is byte-identical to this cheats/ folder but carries no license, so
//   we source from packetpilot/bmw-f (GPL) only. TMD29/BMW-Cheat-Codes_F3X is already included here as
//   cheats/TMD29.xml.
//
// Each XML file shares one schema:
//   <FDL>
//     <cafd id="00000794" name="FEM_BODY" series="F020,F030" author="...">
//       <code description="Human readable function / value">
//         <group id="3062">
//           <function start="68" end="68" mask="11111111b" comment="...">32</function>
//           ...
//   The cafd @author attribute is a person handle and is intentionally NOT ingested (no people data).
//
// Mapping to the target schema:
//   chassis_family  -> derived from the cafd @series families: F / G / I / RR, comma-joined when a CAFD
//                      spans more than one (e.g. "F,G"); null when no series is given. (Was hardcoded "F"
//                      when only FDLCodes.xml was read; that is wrong now that the data spans G-series.)
//   series          -> the raw cafd @series list (e.g. "F020,F030,G011"); per-chassis applicability.
//   ecu_or_cafd     -> "<ECU_NAME>:<0xCAFD>" (e.g. "FEM_BODY:0x00000794")
//   ecu             -> the cafd @name (ECU short name)
//   cafd            -> the cafd @id, 0x-prefixed uppercase
//   fsw_label       -> "<group>/<start>" locus (the FDL analog of an FSW: which byte, in which group)
//   value_label     -> symbolic enum write token (e.g. Aktiv, TFL_S) or null
//   value_hex       -> 0x-prefixed byte value when numeric, or null
//   meaning         -> the parent <code @description> (the human-readable effect)
//   comment         -> the <function @comment> when present (per-write note)
//   source          -> provenance string (repo + license); per-contributor author file is NOT recorded
//
// One row per distinct coding write. Because contributors copy each other, the same write recurs across
// files; rows are DE-DUPED on (cafd, group, byte_start, byte_end, mask, raw_value), keeping the variant
// that carries a description. Zero deps: a tiny tag-stream scanner (flat attribute-driven XML).

import { createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.BMW_REPO_ROOT ? resolve(process.env.BMW_REPO_ROOT) : resolve(__dirname, '..', '..');  // the repo collection root
const OUT_DIR = join(__dirname, '..', 'build', 'external');
const OUT_FILE = join(OUT_DIR, 'fdl_code.ndjson');

// All FDL cheat XML lives in packetpilot/bmw-f/cheats. Override with --dir=PATH.
const CHEATS_DIR = argVal('dir') || join(ROOT, 'bmw-f', 'cheats');
const SRC_REPO = 'github.com/packetpilot/bmw-f';
const LICENSE = 'GPL-3.0';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function argVal(name) {
  const pfx = '--' + name + '=';
  const a = process.argv.find(x => x.startsWith(pfx));
  return a ? a.slice(pfx.length) : null;
}

function decodeEntities(s) {
  if (s == null) return s;
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseAttrs(body) {
  const attrs = {};
  for (const m of body.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = decodeEntities(m[2]);
  return attrs;
}

function* tokens(xml) {
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');                 // drop comments (incl. <!-- Sample Only -->)
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  for (const m of xml.matchAll(tagRe)) {
    const text = xml.slice(last, m.index);
    if (text.trim() !== '') yield { type: 'text', value: text };
    last = m.index + m[0].length;
    const name = m[2];
    if (m[1] === '/') { yield { type: 'close', name }; }
    else { yield { type: 'open', name, attrs: parseAttrs(m[3]), selfClose: m[4] === '/' }; if (m[4] === '/') yield { type: 'close', name }; }
  }
}

const HEX_RE = /^[0-9A-Fa-f]{1,2}$/;
function valueParts(raw) {
  const v = (raw == null ? '' : String(raw)).trim();
  if (v === '') return { value_label: null, value_hex: null };
  if (HEX_RE.test(v)) return { value_label: null, value_hex: '0x' + parseInt(v, 16).toString(16).toUpperCase().padStart(2, '0') };
  return { value_label: v, value_hex: null };
}

function cafdId(id) {
  if (!id) return null;
  return '0x' + String(id).trim().replace(/^0x/i, '').toUpperCase();
}

// Distinct vehicle families from a series list: F / G / I / U / RR, comma-joined, sorted; null if none.
function familyOf(series) {
  if (!series) return null;
  const fams = new Set();
  for (const tok of String(series).split(',')) {
    const m = tok.trim().toUpperCase().match(/^(RR|[FGIU])/);
    if (m) fams.add(m[1]);
  }
  return fams.size ? [...fams].sort().join(',') : null;
}

// Parse one cheat XML file into an array of function-write records.
function parseFile(xml) {
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1);
  const recs = [];
  let cafd = null, code = null, group = null, curFn = null;

  function emit() {
    if (!curFn) return;
    const a = curFn.attrs || {};
    const rawValue = decodeEntities((curFn.text || '').trim());
    const { value_label, value_hex } = valueParts(rawValue);
    const ecu = cafd ? cafd.name : null;
    const cafdHex = cafd ? cafdId(cafd.id) : null;
    const groupId = group ? group.id : null;
    const start = a.start != null ? a.start : null;
    const fsw_label = (groupId != null && start != null) ? `${groupId}/${start}` : (groupId != null ? `${groupId}` : null);
    const series = cafd && cafd.series ? cafd.series : null;
    recs.push({
      chassis_family: familyOf(series),
      ecu_or_cafd: (ecu || cafdHex) ? `${ecu || '?'}:${cafdHex || '?'}` : null,
      ecu,
      cafd: cafdHex,
      fsw_label,
      value_label,
      value_hex,
      meaning: code ? code.description : null,
      group: groupId,
      byte_start: start != null ? Number(start) : null,
      byte_end: a.end != null ? Number(a.end) : null,
      mask: a.mask != null ? a.mask : null,
      raw_value: rawValue || null,
      series,
      comment: a.comment != null ? a.comment : null,
    });
    curFn = null;
  }

  for (const t of tokens(xml)) {
    if (t.type === 'open') {
      const n = t.name.toLowerCase();
      if (n === 'cafd') cafd = { id: t.attrs.id || null, name: (t.attrs.name || '').trim() || null, series: (t.attrs.series || '').trim() || null };
      else if (n === 'code') code = { description: (t.attrs.description != null ? t.attrs.description : '').trim() || null };
      else if (n === 'group') group = { id: t.attrs.id != null ? String(t.attrs.id).trim() : null };
      else if (n === 'function') { emit(); curFn = { attrs: t.attrs, text: '' }; if (t.selfClose) emit(); }
    } else if (t.type === 'text') { if (curFn) curFn.text += t.value; }
    else if (t.type === 'close') {
      const n = t.name.toLowerCase();
      if (n === 'function') emit();
      else if (n === 'group') group = null;
      else if (n === 'code') code = null;
      else if (n === 'cafd') cafd = null;
    }
  }
  emit();
  return recs;
}

function listXml(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(n => extname(n).toLowerCase() === '.xml')
    .map(n => join(dir, n))
    .filter(p => { try { return statSync(p).isFile(); } catch { return false; } })
    .sort();   // stable order -> deterministic de-dup winner
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = listXml(CHEATS_DIR);
  const source = `${SRC_REPO}/cheats/*.xml (${LICENSE})`;
  const caveats = [];

  if (files.length === 0) {
    createWriteStream(OUT_FILE).end();
    log('No FDL cheat XML found in ' + CHEATS_DIR);
    log('Fetch packetpilot/bmw-f (sources.json) or pass --dir=PATH to its cheats/ folder.');
    log('REPORT ' + JSON.stringify({ files: 0, cafds: 0, rows: 0, dir: CHEATS_DIR }));
    process.exit(1);   // fail loudly: an empty fdl_code layer must never be built silently
  }

  // De-dup on the coding write; keep the variant that carries a description.
  const byKey = new Map();
  let rawCount = 0, badFiles = 0;
  for (const f of files) {
    let recs;
    try { recs = parseFile(readFileSync(f, 'utf8')); } catch { badFiles++; continue; }
    for (const r of recs) {
      rawCount++;
      const key = [r.cafd, r.group, r.byte_start, r.byte_end, r.mask, r.raw_value].join('|');
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, r);
      else if ((!prev.meaning || prev.meaning === '') && r.meaning) byKey.set(key, r);   // prefer described
    }
  }

  const out = createWriteStream(OUT_FILE);
  const ecuSet = new Set(), cafdSet = new Set(), famSet = new Set(), seriesSet = new Set();
  let rows = 0;
  for (const r of byKey.values()) {
    if (r.ecu) ecuSet.add(r.ecu);
    if (r.cafd) cafdSet.add(r.cafd);
    if (r.chassis_family) r.chassis_family.split(',').forEach(x => famSet.add(x));
    if (r.series) r.series.split(',').forEach(x => seriesSet.add(x.trim().toUpperCase()));
    out.write(JSON.stringify({ ...r, source }) + '\n');
    rows++;
  }
  out.end();

  out.on('finish', () => {
    if (badFiles) caveats.push(badFiles + ' XML file(s) failed to parse and were skipped.');
    caveats.push('All rows are community E-Sys FDL coding cheats from packetpilot/bmw-f cheats/*.xml (GPL-3.0); FETCHED, not reconstructed. Underlying byte/mask/value data derives from BMW PSdZData CAFD definitions.');
    caveats.push('chassis_family is derived from the cafd series (F/G/I/RR); null when a CAFD gives no series. series holds the raw per-chassis list.');
    caveats.push('De-duped on (cafd, group, byte_start, byte_end, mask, raw_value); contributors copy each other so the raw count is much higher than the kept rows.');
    caveats.push('The cafd @author handle is intentionally not ingested (no people data).');
    log('REPORT ' + JSON.stringify({
      files: files.length, bad_files: badFiles, raw_functions: rawCount, rows,
      distinct_ecus: ecuSet.size, distinct_cafds: cafdSet.size,
      families: [...famSet].sort(), series_count: seriesSet.size,
    }));
    log('CAVEATS ' + JSON.stringify(caveats));
    log('OUT ' + OUT_FILE);
  });
}

main();
