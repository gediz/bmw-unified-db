#!/usr/bin/env node
// winkfp.mjs — WinKFP flash-programming DB → ECU-identification + flash-eligibility layer.
//
// SAFETY: This feeds ECU FLASH PROGRAMMING. Flashing the wrong image can permanently
// brick an ECU. We INGEST this data for REFERENCE/LABELLING ONLY. Nothing here actions
// a flash. Every emitted row is reference metadata; never fabricate values — we only
// extract what is literally present in the source bytes.
//
// Zero-dependency Node ESM (Node v22). Streams NDJSON, skip-and-logs bad rows.
//
// Sources (BMW gdaten, WinKFP / NPS programming station):
//   HWNR.DA2     ~9043 hardware-part-number -> ECU-type rows  (comma CSV, ;$SG headers)
//   KFCONF10.DA2  ~619 ECU -> flash-program(.ipo) mappings     (fixed-width, ME lines)
//   SGIDC.as2 / SGIDD.as2  SG-ID tables ($K ECU <AT+addr><hash>)
//   INFO.GER      $AA AT addr idx ECU <german description>     (descriptions)
//   prgifsel.dat  programming-interface selection (KWP2000/DS2 per ECU)  [supplementary]
//
// Outputs:
//   build/flash/ecu_hwnr.ndjson  { hwnr, ecu_type, at_name, description, source_file, ... }
//   build/flash/flash_map.ndjson { ecu_type, sgbd, flash_program, sgid, source_file, ... }
//
// Join key: sgbd = lowercased ECU-type name (per SCHEMA.md universal join key).

import { createReadStream, createWriteStream, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const SRC = resolve(process.env.BMW_REPO_ROOT ? resolve(process.env.BMW_REPO_ROOT) : resolve(REPO, '..'), 'bmw-advanced-tools/app/EC-APPS/NFS/DATA/gdaten');
const OUT = resolve(REPO, 'build/flash');

const F = {
  HWNR: resolve(SRC, 'HWNR.DA2'),
  KFCONF: resolve(SRC, 'KFCONF10.DA2'),
  SGIDC: resolve(SRC, 'SGIDC.as2'),
  SGIDD: resolve(SRC, 'SGIDD.as2'),
  INFO: resolve(SRC, 'INFO.GER'),
  PRGIFSEL: resolve(SRC, 'prgifsel.dat'),
  SGBD_VARIANT: resolve(REPO, 'build/sgbd/ecu_variant.ndjson'),
};

// ---- helpers -------------------------------------------------------------

const caveats = [];
const note = (m) => { caveats.push(m); };

// sgbd join key per SCHEMA.md: lowercase, trimmed. WinKFP ECU-type names have no extension.
const toSgbd = (name) => (name || '').trim().toLowerCase();

// Strip the leading length/format-prefix digits that WinKFP prepends to a filename
// inside a fixed-width cell, e.g. "16ABS56.ipo" -> "ABS56.ipo", "080100AFS70.ipo" -> "AFS70.ipo".
// The prefix is the NPS format/transfer code, not part of the filename. We keep raw too.
function splitPrefixedFile(cell) {
  const raw = (cell || '').trim();
  if (!raw) return { prefix: '', file: '' };
  const m = raw.match(/^(\d+)(.+)$/);
  if (m && /[.]/.test(m[2])) return { prefix: m[1], file: m[2] };
  return { prefix: '', file: raw };
}

// Read a latin-1 (cp1252-ish) text file as lines, splitting on CRLF/LF. The DA2/as2/GER
// files are DOS text with German umlauts in latin-1.
async function* readLines(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'latin1' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line.replace(/\r$/, '');
}

function makeWriter(path) {
  const ws = createWriteStream(path, { encoding: 'utf8' });
  let n = 0;
  return {
    write(obj) { ws.write(JSON.stringify(obj) + '\n'); n++; },
    count() { return n; },
    end() { return new Promise((res) => ws.end(res)); },
  };
}

// ---- load known sgbd set (from diagnostics layer) for coverage join -------

function loadKnownSgbd() {
  const set = new Set();
  if (!existsSync(F.SGBD_VARIANT)) {
    note(`sgbd layer not found at ${F.SGBD_VARIANT}; ecu_type->sgbd coverage will report 0 known.`);
    return set;
  }
  try {
    const txt = readFileSync(F.SGBD_VARIANT, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.sgbd) set.add(String(o.sgbd).toLowerCase());
      } catch { /* skip malformed */ }
    }
  } catch (e) {
    note(`failed reading sgbd layer for coverage: ${e.message}`);
  }
  return set;
}

// ---- INFO.GER: AT/addr/idx/ECU -> german description ----------------------
// Line: "$AA QY 29 01 ABS56                  <description...>"
function loadInfoDescriptions() {
  const byKey = new Map();   // "AT|addr|idx" -> {desc, ecu}
  const byEcu = new Map();   // ecu(lower) -> desc (first non-"-" wins)
  if (!existsSync(F.INFO)) { note('INFO.GER missing; descriptions empty.'); return { byKey, byEcu }; }
  const raw = readFileSync(F.INFO, 'latin1');
  for (const lineR of raw.split(/\r?\n/)) {
    if (!lineR.startsWith('$AA ')) continue;
    // tokens: $AA AT addr idx ECU  rest(description)
    const parts = lineR.slice(4).split(/\s+/);
    if (parts.length < 4) continue;
    const [at, addr, idx, ecu] = parts;
    // description = everything after the ECU token (preserve internal spacing, trim)
    const afterEcuIdx = lineR.indexOf(ecu, 4 + at.length + 1 + addr.length + 1 + idx.length + 1);
    let desc = '';
    if (afterEcuIdx >= 0) desc = lineR.slice(afterEcuIdx + ecu.length).trim();
    if (desc === '-' ) desc = '';
    const key = `${at}|${addr}|${idx}`;
    byKey.set(key, { desc, ecu });
    const el = toSgbd(ecu);
    if (desc && !byEcu.has(el)) byEcu.set(el, desc);
  }
  return { byKey, byEcu };
}

// ---- SGID tables: ECU -> sgid token (AT+addr prefix) ----------------------
// Line: "$K ABS56               QY29AB0321c080..."  (ECU padded 20, then AT(2)+addr(2)+...)
// The leading 4 chars of the token are AT(2 alnum) + addr(2 hex) = the SG programming id.
function loadSgid(path, srcName, out) {
  if (!existsSync(path)) { note(`${srcName} missing.`); return; }
  const raw = readFileSync(path, 'latin1');
  let rows = 0, bad = 0;
  for (const lineR of raw.split(/\r?\n/)) {
    if (!lineR.startsWith('$K ')) continue;
    const body = lineR.slice(3);
    const ecu = body.slice(0, 20).trim();
    const token = body.slice(20).trim();
    if (!ecu || token.length < 4) { bad++; continue; }
    const at = token.slice(0, 2);
    const addr = token.slice(2, 4);
    const sgid = at + addr;           // e.g. "QY29"
    rows++;
    const key = toSgbd(ecu);
    // first table (SGIDC) wins; record both if differing
    if (!out.has(key)) out.set(key, { sgid, at, addr, source: srcName });
  }
  return { rows, bad };
}

// ---- prgifsel.dat: ECU -> programming protocol (supplementary) ------------
// Line: "SG EK924    -         -              -                  KWP2000*      ..."
function loadPrgIfSel() {
  const byEcu = new Map();
  if (!existsSync(F.PRGIFSEL)) { note('prgifsel.dat missing.'); return byEcu; }
  const raw = readFileSync(F.PRGIFSEL, 'latin1');
  for (const lineR of raw.split(/\r?\n/)) {
    if (!lineR.startsWith('SG ')) continue;   // active rows only; ";SG" are commented-out
    const parts = lineR.slice(3).split(/\s+/);
    if (parts.length < 5) continue;
    const ecu = parts[0];
    const proto = parts[4];   // KWP2000*/DS2/etc
    if (ecu) byEcu.set(toSgbd(ecu), proto);
  }
  return byEcu;
}

// ---- main ----------------------------------------------------------------

async function main() {
  if (!existsSync(SRC)) {
    note(`SOURCE DIR MISSING: ${SRC}`);
    return { fatal: true };
  }
  mkdirSync(OUT, { recursive: true });

  const knownSgbd = loadKnownSgbd();
  const { byKey: infoByKey, byEcu: infoByEcu } = loadInfoDescriptions();
  const prgProto = loadPrgIfSel();

  const sgidMap = new Map();   // sgbd -> {sgid, at, addr, source}
  const cR = loadSgid(F.SGIDC, 'SGIDC.as2', sgidMap) || { rows: 0, bad: 0 };
  // SGIDD supplements (entries not already in SGIDC)
  const dR = loadSgid(F.SGIDD, 'SGIDD.as2', sgidMap) || { rows: 0, bad: 0 };
  note(`SGID tables loaded: SGIDC=${cR.rows} rows (bad ${cR.bad}), SGIDD=${dR.rows} rows (bad ${dR.bad}); distinct ECUs with sgid=${sgidMap.size}.`);

  // ---- HWNR.DA2 -> ecu_hwnr.ndjson --------------------------------------
  const hwnrW = makeWriter(resolve(OUT, 'ecu_hwnr.ndjson'));
  let hwnrCur = null;          // current ;$SG <type> section
  let hwnrData = 0, hwnrSkipped = 0;
  const hwnrEcuTypes = new Set();

  for await (const line of readLines(F.HWNR)) {
    if (line.startsWith(';$SG ')) { hwnrCur = line.slice(5).trim(); continue; }
    if (!line || line.startsWith(';')) continue;   // comments / separators
    const parts = line.split(',');
    if (parts.length !== 4) { hwnrSkipped++; if (hwnrSkipped <= 5) note(`HWNR skip (cols=${parts.length}): ${line.slice(0, 60)}`); continue; }
    const hwnr = parts[0].trim();
    const atHwnr = parts[1].trim();      // AT (replacement) part number, 0000000 = none
    const epTsnr = parts[2].trim();      // EP/TSNR, 0000000 = none
    const ecuType = parts[3].trim();     // SG_TYP
    if (!hwnr || !ecuType) { hwnrSkipped++; continue; }
    const sgbd = toSgbd(ecuType);
    hwnrEcuTypes.add(sgbd);
    // description: prefer per-ECU INFO description if available
    const description = infoByEcu.get(sgbd) || '';
    hwnrW.write({
      hwnr,
      ecu_type: ecuType,
      sgbd,
      at_hwnr: atHwnr === '0000000' ? '' : atHwnr,
      ep_tsnr: epTsnr === '0000000' ? '' : epTsnr,
      at_name: (sgidMap.get(sgbd)?.at) || '',     // 2-char AT programming code
      description,
      source_file: 'HWNR.DA2',
    });
    hwnrData++;
  }
  await hwnrW.end();

  // ---- KFCONF10.DA2 -> flash_map.ndjson ---------------------------------
  // Fixed columns (0-based): AT@3, addr@6, idx@9, ECU@12, ipo@35, flash.prg@66, fmt@97
  const flashW = makeWriter(resolve(OUT, 'flash_map.ndjson'));
  let flashData = 0, flashSkipped = 0;
  const flashEcuTypes = new Set();

  for await (const line of readLines(F.KFCONF)) {
    if (!line.startsWith('ME ')) continue;   // header/comment/version lines skipped
    // tolerant fixed-width slice; trim each cell
    const at = line.slice(3, 5).trim();
    const addr = line.slice(6, 8).trim();
    const idx = line.slice(9, 11).trim();
    const ecu = line.slice(12, 35).trim();
    const ipoCell = line.slice(35, 66).trim();
    const flashCell = line.slice(66, 97).trim();
    const fmtFlag = line.slice(97, 106).trim();   // e.g. XXFLKP / RBFLD2
    if (!ecu) { flashSkipped++; if (flashSkipped <= 5) note(`KFCONF skip (no ECU): ${line.slice(0, 50)}`); continue; }

    const { prefix: ipoPrefix, file: ipoFile } = splitPrefixedFile(ipoCell);
    const { prefix: flashPrefix, file: flashFile } = splitPrefixedFile(flashCell);
    const sgbd = toSgbd(ecu);
    flashEcuTypes.add(sgbd);

    const sg = sgidMap.get(sgbd);
    const infoKey = `${at}|${addr}|${idx}`;
    const description = infoByKey.get(infoKey)?.desc || infoByEcu.get(sgbd) || '';

    flashW.write({
      ecu_type: ecu,
      sgbd,
      sg_address: addr,                         // diag/programming address (hex)
      sg_index: idx,
      flash_program: ipoFile,                   // the .ipo programming control file
      flash_program_prefix: ipoPrefix,          // NPS format/transfer code
      flash_driver: flashFile,                  // the FLASH.prg bootstrap/driver
      flash_driver_prefix: flashPrefix,
      format_flag: fmtFlag,                      // XXFLKP / RBFLD2 etc.
      sgid: sg ? sg.sgid : (at + addr),         // AT+addr SG-ID; fall back to KFCONF tuple
      at_name: at,                              // 2-char AT programming code
      description,                              // german label from INFO.GER ($AA AT|addr|idx)
      sgid_source: sg ? sg.source : '',
      programming_protocol: prgProto.get(sgbd) || '',
      // SAFETY label: reference only, do not action.
      usage: 'reference-only; do-not-flash',
      source_file: 'KFCONF10.DA2',
    });
    flashData++;
  }
  await flashW.end();

  // ---- coverage: how many ecu_type resolve to a known sgbd --------------
  const allEcuTypes = new Set([...hwnrEcuTypes, ...flashEcuTypes]);
  let flashKnown = 0;
  for (const t of flashEcuTypes) if (knownSgbd.has(t)) flashKnown++;
  let hwnrKnown = 0;
  for (const t of hwnrEcuTypes) if (knownSgbd.has(t)) hwnrKnown++;
  let allKnown = 0;
  for (const t of allEcuTypes) if (knownSgbd.has(t)) allKnown++;

  return {
    files: [
      { entity: 'ecu_hwnr', path: resolve(OUT, 'ecu_hwnr.ndjson'), rows: hwnrW.count() },
      { entity: 'flash_map', path: resolve(OUT, 'flash_map.ndjson'), rows: flashW.count() },
    ],
    stats: {
      hwnr_rows: hwnrData, hwnr_skipped: hwnrSkipped,
      flash_rows: flashData, flash_skipped: flashSkipped,
      distinct_ecu_type_hwnr: hwnrEcuTypes.size,
      distinct_ecu_type_flash: flashEcuTypes.size,
      distinct_ecu_type_all: allEcuTypes.size,
      known_sgbd_total: knownSgbd.size,
      flash_ecu_type_resolving_to_known_sgbd: flashKnown,
      hwnr_ecu_type_resolving_to_known_sgbd: hwnrKnown,
      all_ecu_type_resolving_to_known_sgbd: allKnown,
      sgid_ecus: sgidMap.size,
    },
  };
}

const result = await main();
console.log(JSON.stringify({ parser: 'winkfp', ...result, caveats }, null, 2));
