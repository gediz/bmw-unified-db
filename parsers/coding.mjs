#!/usr/bin/env node
// BMW Unified DB — Layer 3: CODING
// Zero-dependency Node ESM (Node v22). Emits NDJSON:
//   build/coding/coding_label.ndjson   — catalog of codeable functions (FSW) + PSW options + meaning, tagged by chassis
//   build/coding/coding_example.ndjson — real-world applied coding from *.TRC corpora
//
// Sources:
//   - FSW_PSW *.TRC files (the only reliable text source of FSW->PSW pairs in this repo):
//       BMW_coding/*FSW_PSW.TRC                               (source_car E82_135i)
//       diesel-x5m/**/FSW_PSW.TRC                             (source_car E70_X5d)
//       bmw-advanced-tools/app/NCSEXPER/BIN/fsw_psw.dat       (NCS default-coding sample, FSW_PSW format)
//   - NCS Dummy data: NCSEXPER/NCS_Dummy/Translations.csv     (German token -> English meaning dictionary)
//
// SP-DATEN coding binaries (NCSEXPER/DATEN/<chassis>/*.C##) are the canonical FSW catalog, but the
// FSW function names are stored as NUMERIC codes there (the text<->code map lives in separate PABD/SGBMW
// lookup tables not present in this tree), so reliable FSW-LABEL extraction from those binaries is not
// feasible here. We therefore build the label catalog from the parseable FSW_PSW corpus and enrich
// meanings from the NCS Dummy Translations.csv. This is noted as a coverage caveat.
//
// Join key contract (SCHEMA.md): sgbd = SGBD filename lowercased w/o extension (e.g. CAS3.C09 -> "cas3").

import { createReadStream, createWriteStream, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, dirname, resolve, relative, sep } from 'node:path';

// repo root resolved relative to this file (parsers/ -> bmw-unified-db/ -> repo root), so no build-host path is baked in
const ROOT = process.env.BMW_REPO_ROOT ? resolve(process.env.BMW_REPO_ROOT) : join(import.meta.dirname, '..', '..');
const OUT_DIR = join(import.meta.dirname, '..', 'build', 'coding');
const TRANSLATIONS = join(ROOT, 'bmw-advanced-tools/app/NCSEXPER/NCS_Dummy/Translations.csv');
const FSW_PSW_DAT = join(ROOT, 'bmw-advanced-tools/app/NCSEXPER/BIN/fsw_psw.dat');
const BMW_CODING_DIR = join(ROOT, 'BMW_coding');
const DIESEL_DIR = join(ROOT, 'diesel-x5m');

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ----------------------------------------------------------------------------
// CSV line parser (handles quoted fields w/ embedded commas + doubled quotes)
// ----------------------------------------------------------------------------
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ----------------------------------------------------------------------------
// Load Translations.csv (ISO-8859-1) -> Map<lowercased token, meaning>
// ----------------------------------------------------------------------------
function loadTranslations() {
  const map = new Map();
  if (!existsSync(TRANSLATIONS)) { log('WARN translations missing:', TRANSLATIONS); return map; }
  let buf;
  try { buf = readFileSync(TRANSLATIONS); } catch (e) { log('WARN read translations:', e.message); return map; }
  const text = buf.toString('latin1');
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (cells.length < 2) continue;
    const key = cells[0].trim();
    const val = cells[1].trim();
    if (!key) continue;
    // skip metadata header rows
    if (key === 'CONTRIBUTORS' || key === 'LASTMODIFIED') continue;
    if (val) map.set(key.toLowerCase(), val);
  }
  return map;
}

// ----------------------------------------------------------------------------
// Chassis token helpers
// ----------------------------------------------------------------------------
const CHASSIS_RE = /\b([EFGURK]\d{1,2}[A-Z]?|RR\d)\b/i;
function chassisFromToken(tok) {
  if (!tok) return null;
  const m = String(tok).toUpperCase().match(/^([EFGURK]\d{1,2}[A-Z]?|RR\d)$/);
  return m ? m[1] : null;
}

// sgbd join key from an SGBD filename like "CAS3.C09" or "FRM3_E70.C33" -> "cas3" / "frm3_e70"
function sgbdKey(sgbdFile) {
  if (!sgbdFile) return null;
  return basename(sgbdFile).replace(/\.[^.]*$/, '').toLowerCase();
}

// ----------------------------------------------------------------------------
// Parse an FSW_PSW text file into ordered { fsw, psw, ord } pairs + header tokens.
// Format: a non-tab line is an FSW label; it OWNS every immediately following
// tab/space-indented value line until the next label. Most FSW have exactly one
// PSW, but multi-byte coding parameters list several consecutive values (one per
// data byte) — we keep ALL of them, with `ord` giving the value's position.
// Header section (BAUREIHE/BAUART/etc) follows the same shape; BAUREIHE is
// captured for chassis tagging. A label with no value lines is emitted value-less.
// ----------------------------------------------------------------------------
async function parseFswPsw(filePath) {
  const pairs = [];
  let baureihe = null;
  let pendingFsw = null;
  let valCount = 0; // values seen for the current pendingFsw
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'latin1' }), crlfDelay: Infinity });
  const flush = () => {
    if (pendingFsw !== null && valCount === 0) pairs.push({ fsw: pendingFsw, psw: null, ord: 0 });
  };
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (line[0] === '\t' || line[0] === ' ') {
      // value line belonging to the pending FSW
      const val = line.replace(/^[\t ]+/, '').trim();
      if (pendingFsw !== null) {
        if (pendingFsw === 'BAUREIHE' && valCount === 0) baureihe = val.toLowerCase();
        pairs.push({ fsw: pendingFsw, psw: val, ord: valCount });
        valCount++;
      }
      // a value with no preceding label -> ignore (malformed)
    } else {
      // new label line: flush previous (emit value-less if it had no values)
      flush();
      pendingFsw = line.trim();
      valCount = 0;
    }
  }
  flush();
  return { pairs, baureihe };
}

// Header/meta FSW keys that are vehicle-profile descriptors, not codeable functions.
// They are still emitted as examples (they describe the applied profile) but excluded
// from the codeable-function label catalog to keep coding_label clean.
const META_KEYS = new Set([
  'BAUREIHE', 'BAUART', 'MOTOR_ART', 'TYP_LENKUNG', 'ZYLINDER_ZAHL',
  'GETRIEBE_GAENGE', 'KLASSE_BATTERIE',
]);

// ----------------------------------------------------------------------------
// Discover FSW_PSW TRC files in a corpus dir.
// ----------------------------------------------------------------------------
function walk(dir, acc = []) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch { return acc; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function isFswPswTrc(p) {
  const b = basename(p).toUpperCase();
  return b.endsWith('.TRC') && b.includes('FSW_PSW');
}

// From a path, derive { ecu_module, sgbdFile }.
//  - BMW_coding: "E89-CAS3.C09-FSW_PSW.TRC"  -> sgbdFile "CAS3.C09", module from sgbd stem
//  - diesel-x5m: ".../CAS (CAS3.C09)/FSW_PSW.TRC" -> module "CAS", sgbdFile "CAS3.C09"
function deriveModule(p) {
  const b = basename(p);
  // diesel-x5m: parent dir like "CAS (CAS3.C09)"
  const parent = basename(dirname(p));
  const dm = parent.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (dm) {
    return { ecu_module: dm[1].trim(), sgbdFile: dm[2].trim() };
  }
  // BMW_coding: "<CHASSIS>-<SGBD.REV>-FSW_PSW.TRC"
  const bm = b.match(/^([A-Z0-9]+)-(.+?)-FSW_PSW\.TRC$/i);
  if (bm) {
    const sgbdFile = bm[2].trim(); // e.g. CAS3.C09
    const mod = sgbdFile.replace(/\.[^.]*$/, ''); // CAS3
    return { ecu_module: mod, sgbdFile };
  }
  // fallback: generic FSW_PSW.TRC with no useful name
  return { ecu_module: null, sgbdFile: null };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const tr = loadTranslations();
  log(`translations loaded: ${tr.size} tokens`);

  const exampleOut = createWriteStream(join(OUT_DIR, 'coding_example.ndjson'));
  const labelOut = createWriteStream(join(OUT_DIR, 'coding_label.ndjson'));

  const caveats = [];
  let exampleRows = 0;
  let ncsDummyPairs = 0;

  // Catalog accumulator: key = `${sgbd}\u0000${fsw}` -> { sgbd, ecu, fsw, psw:Set, chassis:Set, sources:Set }
  const catalog = new Map();
  function addLabel(sgbd, ecu, fsw, psw, chassis, source) {
    if (META_KEYS.has(fsw)) return; // keep catalog to codeable functions
    const k = sgbd + '\u0000' + fsw;
    let rec = catalog.get(k);
    if (!rec) { rec = { sgbd, ecu, fsw, psw: new Set(), chassis: new Set(), sources: new Set() }; catalog.set(k, rec); }
    if (psw) rec.psw.add(psw);
    if (chassis) rec.chassis.add(chassis);
    if (source) rec.sources.add(source);
  }

  // ---- corpora definitions ----
  const corpora = [
    { dir: BMW_CODING_DIR, source_car: 'E82_135i', defaultChassis: 'E82' },
    { dir: DIESEL_DIR, source_car: 'E70_X5d', defaultChassis: 'E70' },
  ];

  for (const corpus of corpora) {
    if (!existsSync(corpus.dir)) { caveats.push(`corpus dir missing: ${corpus.dir}`); continue; }
    const files = walk(corpus.dir).filter(isFswPswTrc);
    log(`${corpus.source_car}: ${files.length} FSW_PSW.TRC files`);
    let fileOk = 0;
    for (const f of files) {
      let parsed;
      try { parsed = await parseFswPsw(f); }
      catch (e) { caveats.push(`skip ${f}: ${e.message}`); continue; }
      const { ecu_module, sgbdFile } = deriveModule(f);
      const sgbd = sgbdKey(sgbdFile);
      const chassis = (parsed.baureihe && chassisFromToken(parsed.baureihe)) || corpus.defaultChassis;
      if (parsed.pairs.length === 0) { caveats.push(`empty FSW_PSW: ${f}`); continue; }
      fileOk++;
      for (const { fsw, psw, ord } of parsed.pairs) {
        if (psw === null) { caveats.push(`value-less FSW '${fsw}' in ${basename(f)}`); }
        // coding_example: one row per (module, fsw, psw, ord). ord>0 = extra byte
        // of a multi-byte coding parameter.
        const rec = {
          source_car: corpus.source_car,
          ecu_module: ecu_module,
          sgbd: sgbd,
          chassis: chassis,
          fsw: fsw,
          psw: psw,
          ord: ord,
          fsw_meaning: tr.get(fsw.toLowerCase()) || null,
          psw_meaning: psw ? (tr.get(psw.toLowerCase()) || null) : null,
          is_meta: META_KEYS.has(fsw) ? 1 : 0,
          file: relative(ROOT, f).split(sep).join('/'),
        };
        exampleOut.write(JSON.stringify(rec) + '\n');
        exampleRows++;
        // feed catalog (codeable functions only; meta skipped inside addLabel)
        if (sgbd) addLabel(sgbd, sgbd, fsw, psw, chassis, 'trc:' + corpus.source_car);
      }
    }
    log(`${corpus.source_car}: parsed ${fileOk}/${files.length} files ok`);
  }

  // ---- NCS default-coding sample: fsw_psw.dat (FSW_PSW format, ECU-agnostic sample) ----
  if (existsSync(FSW_PSW_DAT)) {
    try {
      const { pairs } = await parseFswPsw(FSW_PSW_DAT);
      log(`fsw_psw.dat: ${pairs.length} pairs`);
      // ECU unknown for this sample; tag sgbd as null-ecu pseudo-entry "ncs_dummy"
      for (const { fsw, psw } of pairs) {
        addLabel('ncs_dummy', 'ncs_dummy', fsw, psw, null, 'ncs:fsw_psw.dat');
      }
      ncsDummyPairs = pairs.length;
    } catch (e) { caveats.push(`fsw_psw.dat: ${e.message}`); }
  } else {
    caveats.push('NCSEXPER/BIN/fsw_psw.dat not found');
  }

  // ---- emit coding_label catalog ----
  let labelRows = 0;
  let withMeaning = 0;
  for (const rec of catalog.values()) {
    const psw_values = [...rec.psw].sort();
    const chassis = [...rec.chassis].sort();
    const meaning = tr.get(rec.fsw.toLowerCase()) || null;
    if (meaning) withMeaning++;
    // also translate each psw value into a small {value, meaning} list when known
    const psw_options = psw_values.map(v => ({ value: v, meaning: tr.get(v.toLowerCase()) || null }));
    const out = {
      ecu: rec.ecu,             // sgbd join key (per schema "ecu")
      sgbd: rec.sgbd,
      chassis: chassis,         // json[] string in NDJSON
      fsw_label: rec.fsw,
      psw_values: psw_values,   // json[]
      psw_options: psw_options, // enriched value->meaning
      meaning: meaning,
      source: [...rec.sources].sort().join(','),
    };
    labelOut.write(JSON.stringify(out) + '\n');
    labelRows++;
  }

  await Promise.all([
    new Promise(r => exampleOut.end(r)),
    new Promise(r => labelOut.end(r)),
  ]);

  // ---- coverage caveats ----
  caveats.push('SP-DATEN coding binaries (NCSEXPER/DATEN/<chassis>/*.C##) are E-series only and store FSW as numeric codes; FSW *label* text requires PABD/SGBMW cross-ref tables absent from this tree, so the label catalog is sourced from the FSW_PSW TRC corpus + fsw_psw.dat enriched via NCS Dummy Translations.csv, not mined from the .C## binaries.');
  caveats.push('coding_example chassis: BMW_coding folder data packages are labelled E89 but the donor vehicle is an E82 135i (source_car=E82_135i); BAUREIHE inside the TRC (e82/e70) is preferred for the chassis tag, falling back to the corpus default.');
  caveats.push('Both Default ECUs and Coded ECUs trees under diesel-x5m are included; provenance is preserved in the `file` column.');

  const report = {
    labelRows, exampleRows, withMeaning, ncsDummyPairs,
    translationsTokens: tr.size,
  };
  log('REPORT ' + JSON.stringify(report));
  // print sample rows for validation is done by the runner below
  return report;
}

main().catch(e => { log('FATAL', e.stack || e.message); process.exit(1); });
