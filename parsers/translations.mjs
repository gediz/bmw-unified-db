#!/usr/bin/env node
// translations.mjs — merged German->English coding translation dictionary.
//
// Builds the UNION of the two Translations.csv files shipped in bmw-advanced-tools:
//   - EC-APPS/BMWCodingTool/Translations.csv   (LASTMODIFIED 20110827)
//   - NCSEXPER/NCS_Dummy/Translations.csv      (LASTMODIFIED 20201210, newer)
//
// Source format (verified by inspection):
//   * 2-column CSV, RFC4180 quoting ("" escapes a quote, quotes wrap embedded commas).
//   * CRLF line endings, no embedded newlines inside fields.
//   * Encoding is Latin-1 / Windows-1252 (e.g. 0xB0 = degree sign). NOT utf-8.
//   * First column = German coding token (lookup key). Second column = English meaning.
//   * Two metadata rows at the top: CONTRIBUTORS,... and LASTMODIFIED,... — skipped.
//   * Many tokens carry an EMPTY meaning (untranslated); kept but flagged via meaning_en="".
//
// Output: build/translation/translation.ndjson  — one JSON object per line:
//   { token, meaning_en, source, meaning_alt? }
//     token       — the German token, verbatim (the join/lookup key for coding labels)
//     meaning_en  — preferred English meaning (see merge rule), "" if neither file has one
//     source      — "both" | "bmw" | "ncs"  (which file(s) defined the token)
//     meaning_alt — present ONLY when both files give a differing NON-EMPTY meaning;
//                   holds the BMWCodingTool value we did not pick (NCS wins as it is newer)
//
// Merge rule (dedupe on token):
//   1. Prefer a NON-EMPTY meaning over an empty one.
//   2. If BOTH files have a non-empty meaning and they differ, prefer NCS (newer 2020 file)
//      and record the BMWCodingTool alternate in meaning_alt so nothing is lost.
//   3. If only one file has the token, use it.
//
// Zero dependencies. Node v22 ESM. Streams output line-by-line.

import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const TOOLS = resolve(process.env.BMW_REPO_ROOT ? resolve(process.env.BMW_REPO_ROOT) : resolve(REPO, '..'), 'bmw-advanced-tools', 'app');

const SOURCES = [
  { key: 'bmw', label: 'BMWCodingTool', path: resolve(TOOLS, 'EC-APPS/BMWCodingTool/Translations.csv') },
  { key: 'ncs', label: 'NCS_Dummy',     path: resolve(TOOLS, 'NCSEXPER/NCS_Dummy/Translations.csv') },
];

const OUT_DIR = resolve(REPO, 'build', 'translation');
const OUT_FILE = resolve(OUT_DIR, 'translation.ndjson');

const META_KEYS = new Set(['CONTRIBUTORS', 'LASTMODIFIED']);

// Parse one logical CSV line (no embedded newlines) into fields, RFC4180-style.
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(field); field = ''; }
      else field += c;
    }
  }
  out.push(field);
  return out;
}

// Load one Translations.csv into Map<token, meaning>. Returns {map, stats}.
function loadFile(src) {
  const stats = { rows: 0, parsed: 0, meta: 0, malformed: 0, empty: 0, dupTokens: 0 };
  const map = new Map();
  if (!existsSync(src.path)) {
    console.error(`[skip] missing source: ${src.path}`);
    stats.missing = true;
    return { map, stats };
  }
  // Latin-1 decode (Windows-1252 superset for the bytes present here: degree sign etc.).
  const text = readFileSync(src.path, 'latin1');
  const lines = text.split(/\r\n|\r|\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (line === '') continue; // trailing/blank line
    stats.rows++;
    let fields;
    try {
      fields = parseCsvLine(line);
    } catch (e) {
      stats.malformed++;
      console.error(`[skip] ${src.label}:${ln + 1} parse error: ${e.message}`);
      continue;
    }
    if (fields.length < 2) {
      stats.malformed++;
      console.error(`[skip] ${src.label}:${ln + 1} expected >=2 columns, got ${fields.length}: ${JSON.stringify(line).slice(0, 80)}`);
      continue;
    }
    const token = fields[0];
    if (META_KEYS.has(token)) { stats.meta++; continue; }
    if (token === '') { stats.malformed++; continue; } // no usable key
    // Join columns 2..n with comma in the unlikely event of >2 cols (none observed),
    // so we never silently drop part of a meaning.
    const meaning = fields.slice(1).join(',');
    if (meaning.trim() === '') stats.empty++;
    if (map.has(token)) stats.dupTokens++; // last write wins within a single file
    map.set(token, meaning);
    stats.parsed++;
  }
  return { map, stats };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const loaded = SOURCES.map((s) => ({ src: s, ...loadFile(s) }));
  const bmw = loaded.find((l) => l.src.key === 'bmw') ?? { map: new Map(), stats: {} };
  const ncs = loaded.find((l) => l.src.key === 'ncs') ?? { map: new Map(), stats: {} };

  const tokens = new Set([...bmw.map.keys(), ...ncs.map.keys()]);
  // Deterministic output: sort tokens.
  const sorted = [...tokens].sort();

  const ws = createWriteStream(OUT_FILE, { encoding: 'utf8' });

  const m = {
    distinct: 0,
    onlyBmw: 0,
    onlyNcs: 0,
    both: 0,
    bothIdentical: 0,
    ncsFillsEmptyBmw: 0,
    bmwFillsEmptyNcs: 0,
    realConflict: 0,        // both non-empty and differ -> NCS wins, BMW kept in meaning_alt
    withMeaning: 0,
    emptyMeaning: 0,
    onlyBmwWithMeaning: 0,  // the genuinely-new translations we were missing
  };
  const samples = [];

  for (const token of sorted) {
    const hasB = bmw.map.has(token);
    const hasN = ncs.map.has(token);
    const vbRaw = hasB ? bmw.map.get(token) : '';
    const vnRaw = hasN ? ncs.map.get(token) : '';
    const vb = vbRaw.trim();
    const vn = vnRaw.trim();

    let meaning_en = '';
    let source;
    let meaning_alt;

    if (hasB && hasN) {
      m.both++;
      source = 'both';
      if (vb === vn) {
        m.bothIdentical++;
        meaning_en = vnRaw; // identical (incl. both-empty); keep NCS copy
      } else if (vb && vn) {
        m.realConflict++;
        meaning_en = vnRaw;      // prefer NCS (newer 2020 file)
        meaning_alt = vbRaw;     // preserve the BMWCodingTool alternate
      } else if (vn && !vb) {
        m.ncsFillsEmptyBmw++;
        meaning_en = vnRaw;
      } else { // vb && !vn
        m.bmwFillsEmptyNcs++;
        meaning_en = vbRaw;
      }
    } else if (hasB) {
      m.onlyBmw++;
      source = 'bmw';
      meaning_en = vbRaw;
      if (vb) m.onlyBmwWithMeaning++;
    } else {
      m.onlyNcs++;
      source = 'ncs';
      meaning_en = vnRaw;
    }

    if (meaning_en.trim() === '') m.emptyMeaning++; else m.withMeaning++;
    m.distinct++;

    const rec = { token, meaning_en, source };
    if (meaning_alt !== undefined) rec.meaning_alt = meaning_alt;
    ws.write(JSON.stringify(rec) + '\n');

    if (samples.length < 5 && source === 'bmw' && vb) samples.push(rec);
  }

  ws.end();

  ws.on('finish', () => {
    const report = {
      parser: 'translations',
      out: OUT_FILE,
      perFile: {
        bmw: bmw.stats,
        ncs: ncs.stats,
      },
      merge: m,
      sampleOnlyBmw: samples,
    };
    console.log(JSON.stringify(report, null, 2));
  });
}

main();
