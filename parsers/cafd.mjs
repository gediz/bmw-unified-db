#!/usr/bin/env node
// BMW Unified DB — Coding Layer: CAFD (F/G-series E-Sys FDL coding definitions)
// Zero-dependency Node ESM (Node v22). Emits streaming NDJSON:
//   build/cafd/cafd_function.ndjson
//     { cafd, cafd_raw, group, idx, byte_start, byte_end, mask, default_value,
//       vals, fsw_label, label, source }
//
// SOURCE (user-supplied, not a pinned public repo):
//   A directory of CAFD JSON files, one file per CAFD, the filename being the CAFD
//   id in hex (e.g. 0000A2C3.json). This is the decoded BMW FDL coding definition
//   for one ECU coding variant, as found inside BMW PSdZData (\Data\psdzdata\swe\cafd)
//   and exported to JSON by a coding tool / app bundle.
//   Point the parser at the folder with  --dir=PATH  or  CAFD_DIR=PATH.
//
// FILE FORMAT (confirmed against the FDL coding model; see research notes):
//   {
//     "groups": [
//       {
//         "fns": [
//           { "s": 1, "e": 1, "m": "10", "vals": ["00"] },
//           { "s": 1, "e": 1, "m": "E0", "d": "03", "vals": ["00","01",...,"06"] },
//           { "s": 2, "e": 2, "m": "01", "d": "00", "vals": ["00"] },   // byte 2, bit 0
//           { "s": 2, "e": 2, "m": "02", "d": "00", "vals": ["00"] },   // byte 2, bit 1
//           ...                                                          // 04 08 10 20 40 80 FF
//           { "s": 4, "e": 4, "m": "0F", "d": "02", "vals": [...] }     // low nibble
//         ]
//       }
//     ]
//   }
//   s / e  = start / end byte offset of the function within the coding string (group-relative)
//   m      = bit mask; lets one byte be shared across several functions (E0 = top 3 bits, 0F = low nibble)
//   d      = default value (hex), the factory/anlieferung setting; may be absent
//   vals   = the allowed values (hex) the function accepts; may be absent
//
// Mapping to the cafd_function schema:
//   cafd        -> 0x-prefixed uppercase hex of the filename (matches fdl_code.cafd, e.g. 0x0000A2C3)
//   cafd_raw    -> the raw filename id (e.g. 0000A2C3)
//   group       -> the group's id when present, else its 0-based index in groups[]
//   idx         -> 0-based running index of the function across the whole file (stable ordering)
//   byte_start  -> s   (number, or null)
//   byte_end    -> e   (number, or null; falls back to s when only one is given)
//   mask        -> m   (hex string, or null)
//   default_value -> d (hex string, or null; named to avoid the SQL reserved word `default`)
//   vals        -> the allowed-values array (JSON), or null
//   fsw_label   -> "<group>/<byte_start>" locus, the FDL analog used by the fdl_code layer, when both known
//   label       -> a human-readable name if the source carries one (name/label/fsw/desc); usually null,
//                  because the CAFD structure holds offsets/masks/values, not text. English meaning is
//                  resolved downstream by joining the function keyword to the `translation` table.
//   source      -> provenance string (the folder basename)
//
// One row is emitted per coding function, matching the byte/bit-write granularity used elsewhere.
// NOTE: a CAFD is the coding DEFINITION (what is codeable and the allowed values), not the per-car
// coded instance (that is an NCD read off a vehicle). This layer is BMW-derived; treat it under the
// same removable-on-request posture as the other BMW data.

import { createWriteStream, mkdirSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');                 // bmw-unified-db
const OUT_DIR = join(ROOT, 'build', 'cafd');
const OUT_FILE = join(OUT_DIR, 'cafd_function.ndjson');

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function argVal(name) {
  const pfx = '--' + name + '=';
  const a = process.argv.find(x => x.startsWith(pfx));
  return a ? a.slice(pfx.length) : null;
}

// Source folder: --dir=, then CAFD_DIR env, then a conventional default.
const SRC_DIR = argVal('dir') || process.env.CAFD_DIR || join(ROOT, 'cafd');

// 0x-prefixed uppercase hex, matching the existing fdl_code.cafd convention.
function cafdId(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().replace(/^0x/i, '');
  return '0x' + clean.toUpperCase();
}

// First defined value among a set of candidate keys.
function pick(obj, keys) {
  for (const k of keys) {
    if (obj != null && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// hex token (mask / default) normalized to a bare uppercase string, or null.
function hexOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/^0x/i, '');
  return s === '' ? null : s.toUpperCase();
}

// allowed-values array -> array of bare uppercase hex strings, or null.
function valsOrNull(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.map(x => String(x).trim().replace(/^0x/i, '').toUpperCase()).filter(s => s !== '');
  return out.length ? out : null;
}

function listJsonFiles(dir) {
  // recursive walk; the folder may be flat (cafd/*.json) or nested.
  let entries;
  try { entries = readdirSync(dir, { recursive: true }); }
  catch { return []; }
  return entries
    .map(e => join(dir, e))
    .filter(p => { try { return statSync(p).isFile() && extname(p).toLowerCase() === '.json'; } catch { return false; } });
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = createWriteStream(OUT_FILE);

  const source = 'cafd/' + basename(SRC_DIR);

  const caveats = [];
  if (!existsSync(SRC_DIR)) {
    // Graceful no-op, matching the rest of the pipeline: emit nothing, report the missing source.
    out.end();
    out.on('finish', () => {
      log('CAFD source dir not found: ' + SRC_DIR);
      log('Point the parser at the CAFD folder with  --dir=PATH  or  CAFD_DIR=PATH');
      log('REPORT ' + JSON.stringify({ files: 0, cafds: 0, functions: 0, source_dir: SRC_DIR }));
      log('OUT ' + OUT_FILE);
    });
    return;
  }

  const files = listJsonFiles(SRC_DIR);

  let rows = 0, fileCount = 0, badFiles = 0;
  const cafdSet = new Set();
  let withMask = 0, withDefault = 0, withVals = 0, withLabel = 0, withByte = 0;
  let minByte = Infinity, maxByte = -Infinity;

  for (const file of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); }
    catch { badFiles++; continue; }
    fileCount++;

    const cafd_raw = basename(file, extname(file));
    const cafd = cafdId(cafd_raw);
    cafdSet.add(cafd);

    // The functions live under groups[].fns[]. Be tolerant of shape: a top-level groups array,
    // a bare array of groups, or a single object that already exposes a functions array.
    let groups = pick(doc, ['groups', 'g']);
    if (!Array.isArray(groups)) groups = Array.isArray(doc) ? doc : [doc];

    let idx = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi] || {};
      const groupId = pick(g, ['id', 'g', 'group', 'name']);
      const group = groupId != null ? String(groupId) : String(gi);
      let fns = pick(g, ['fns', 'functions', 'f']);
      if (!Array.isArray(fns)) continue;

      for (const fn of fns) {
        if (fn == null || typeof fn !== 'object') continue;
        const s = numOrNull(pick(fn, ['s', 'start']));
        const eRaw = pick(fn, ['e', 'end']);
        const e = eRaw != null ? numOrNull(eRaw) : s;        // single-byte functions omit e
        const mask = hexOrNull(pick(fn, ['m', 'mask']));
        const def = hexOrNull(pick(fn, ['d', 'default', 'def']));
        const vals = valsOrNull(pick(fn, ['vals', 'values', 'v']));
        const label = pick(fn, ['name', 'label', 'fsw', 'n', 'desc', 't']);
        const fsw_label = (s != null) ? `${group}/${s}` : null;

        if (mask != null) withMask++;
        if (def != null) withDefault++;
        if (vals != null) withVals++;
        if (label != null) withLabel++;
        if (s != null) { withByte++; if (s < minByte) minByte = s; if (e != null && e > maxByte) maxByte = e; }

        out.write(JSON.stringify({
          cafd,
          cafd_raw,
          group,
          idx: idx++,
          byte_start: s,
          byte_end: e,
          mask,
          default_value: def,
          vals,
          fsw_label,
          label: label != null ? String(label) : null,
          source,
        }) + '\n');
        rows++;
      }
    }
  }

  out.end();
  out.on('finish', () => {
    if (fileCount === 0) caveats.push('No CAFD JSON files found under ' + SRC_DIR + ' — check the path / structure.');
    if (badFiles) caveats.push(badFiles + ' file(s) failed to parse as JSON and were skipped.');
    if (rows && withLabel === 0) caveats.push('No human-readable labels in any function — the source carries structure only; English meaning must be joined from the translation dictionary by function keyword.');
    caveats.push('CAFD is the coding DEFINITION (allowed values + default), not a per-car NCD instance.');
    caveats.push('BMW-derived data: same removable-on-request posture as the other BMW layers.');

    const report = {
      files: fileCount,
      bad_files: badFiles,
      cafds: cafdSet.size,
      functions: rows,
      with_mask: withMask,
      with_default: withDefault,
      with_vals: withVals,
      with_label: withLabel,
      byte_range: withByte ? [minByte, maxByte] : null,
      source_dir: SRC_DIR,
    };
    log('REPORT ' + JSON.stringify(report));
    log('CAVEATS ' + JSON.stringify(caveats));
    log('OUT ' + OUT_FILE);
  });
}

main();
