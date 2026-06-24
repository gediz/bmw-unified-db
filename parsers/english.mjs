#!/usr/bin/env node
// BMW Unified DB — English-text recovery parser.
//
// GOAL (per task brief): recover ENGLISH text for ECUs. The main corpus
// (Layer 1 `sgbd`) is German; BMW also ships English-translated EDIABAS SGBD
// binaries under  bmw-advanced-tools/app/EDIABAS/EnglishEcu/*.prg.
// We decode those binaries directly and emit, keyed by `sgbd` (lowercased
// filename without .prg):
//
//   build/english/english_dtc.ndjson     : { sgbd, code, location_text_en, ... }
//   build/english/english_job.ndjson     : { sgbd, job, description_en }
//
// Zero dependency. Node v22. Only node: builtins. Streamed NDJSON output.
//
// ---------------------------------------------------------------------------
// BINARY FORMAT (reverse-engineered from the EnglishEcu binaries; same family
// as parsers/routing.mjs and the inpax sgbd-loader)
// ---------------------------------------------------------------------------
// * File starts with ASCII magic "@EDIABAS OBJECT\0". The ENTIRE file body is
//   obfuscated with a single-byte XOR key 0xF7. XOR-ing the whole buffer yields
//   readable Latin-1: the INFO block, the table directory and the cell stream.
//
// * INFO block: each field is stored as
//       "<FIELDNAME>\0" <10-byte fixed prefix> <LEN:u8> 0x00 <value bytes...> 0x00
//   The value length LEN counts the leading 0x00 + the text. We strip the
//   leading/trailing NULs. We only read the fault-text tables below; the INFO
//   author/department fields are intentionally not extracted (they are personal
//   and internal metadata, not car data).
//
// * Table directory: a contiguous run of 80-byte entries. Each entry:
//       +0  u32   (misc count field -- NOT a reliable col/row count)
//       +4  u32   (misc)
//       +8  char  table name, NUL-terminated, padded inside a ~56-byte field
//       +72 u32   dataOff  -> absolute file offset of this table's cell stream
//   The cell stream lives EARLIER in the file than the directory. Cells are
//   NUL-terminated Latin-1 strings laid out row-major: first `cols` header
//   cells, then rows*cols data cells.
//
// * Fault dictionaries (the FORTTEXTE / IORTTEXTE "location text" tables -- the
//   English equivalent of the German FORTTEXTE/IORTTEXTE) have header
//   [ORT, ORTTEXT] (2 cols) or [ORT, ORTTEXT, EREIGNIS_DTC] (3 cols). We detect
//   the column count from the header itself (the +0 field is unreliable for
//   these), read rows until either the next table's dataOff or until col0 stops
//   being a hex fault code (0xNNNN...). location_text_en = the ORTTEXT cell.
//
// NOTE ON COVERAGE / HONESTY: these binaries are *partially* translated. Many
// ECUs (notably engine S-series) still carry German location text; many others
// are a German/English mix. We extract whatever ORTTEXT is present and tag each
// DTC row with a cheap language heuristic (lang: 'en'|'de'|'mixed'|'unknown')
// so downstream layers can prefer genuinely-English strings. Job descriptions
// are compiled to bytecode in these files and are NOT recoverable as clean
// English text -- english_job is emitted only on the rare occasions a clean
// English job-comment string is found, and is otherwise (honestly) sparse.

import {
  readFileSync, createWriteStream, mkdirSync, readdirSync, statSync, existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO, 'bmw-advanced-tools', 'app', 'EDIABAS', 'EnglishEcu');
const OUT_DIR = path.resolve(__dirname, '..', 'build', 'english');
const SGBD_VARIANT = path.resolve(__dirname, '..', 'build', 'sgbd', 'ecu_variant.ndjson');

mkdirSync(OUT_DIR, { recursive: true });

const XOR_KEY = 0xf7;
const MAGIC = '@EDIABAS OBJECT';

const ENTITIES = ['english_dtc', 'english_job'];
const writers = {};
const counts = {};
for (const e of ENTITIES) {
  writers[e] = createWriteStream(path.join(OUT_DIR, e + '.ndjson'));
  counts[e] = 0;
}
function emit(entity, obj) {
  writers[entity].write(JSON.stringify(obj) + '\n');
  counts[entity]++;
}
function closeAll() {
  return Promise.all(ENTITIES.map((e) => new Promise((res) => writers[e].end(res))));
}

function decodeBuf(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ XOR_KEY;
  return out;
}
function u32(dec, off) {
  if (off < 0 || off + 4 > dec.length) return 0;
  return (dec[off] | (dec[off + 1] << 8) | (dec[off + 2] << 16) | (dec[off + 3] * 0x1000000)) >>> 0;
}
function cellAt(dec, p) {
  let e = p;
  while (e < dec.length && dec[e] !== 0) e++;
  return [dec.toString('latin1', p, e), e + 1];
}

const sgbdKey = (name) => String(name).toLowerCase().replace(/\.prg$/i, '').trim();

function readInfoField(dec, s, name) {
  // Value record after "<NAME>\0" is: <prefix bytes><LEN:u8> 0x00 <text> 0x00.
  // The prefix is 10 bytes in ~99.8% of files (8 in a handful). We try those two
  // exact offsets only and REQUIRE the record to be NUL-terminated at q+1+len so
  // a wrong offset can't bleed the previous field's text into this one.
  let from = 0;
  while (true) {
    const i = s.indexOf(name + '\0', from);
    if (i < 0) return null;
    from = i + 1;
    for (const pre of [10, 8]) {
      const q = i + name.length + 1 + pre;
      const len = dec[q];
      if (len == null || len < 2 || len > 200) continue;
      if (dec[q + 1] !== 0x00) continue;             // record begins with a NUL
      if (dec[q + 1 + len] !== 0x00) continue;        // record is NUL-terminated
      const val = s.substr(q + 2, len - 1).replace(/\x00+$/, '');
      if (val.length >= 1 && !/[\x00-\x08\x0b-\x1f]/.test(val)) return val.trim();
    }
  }
}

function isEntryNameAt(dec, e) {
  if (e < 0 || e + 8 + 2 >= dec.length) return false;
  const p = e + 8;
  let k = 0;
  while (k < 48) {
    const b = dec[p + k];
    if (b === 0) break;
    if (b < 0x20 || b >= 0x7f) return false;
    const ch = String.fromCharCode(b);
    if (!/[A-Za-z0-9_]/.test(ch)) return false;
    k++;
  }
  return k >= 2 && dec[p + k] === 0;
}
function collectDataOffsets(dec, s) {
  let anchor = -1;
  for (const nm of ['FORTTEXTE', 'IORTTEXTE', 'FARTTEXTE', 'IARTTEXTE', 'FUMWELTTEXTE']) {
    anchor = s.indexOf(nm);
    if (anchor >= 0) break;
  }
  if (anchor < 0) return [];
  const entry = anchor - 8;
  if (entry < 0) return [];
  let start = entry;
  while (isEntryNameAt(dec, start - 80)) start -= 80;
  let end = entry;
  while (isEntryNameAt(dec, end + 80)) end += 80;
  const offs = [];
  for (let e = start; e <= end; e += 80) {
    const d = u32(dec, e + 72);
    if (d > 0 && d < dec.length) offs.push(d);
  }
  return offs.sort((a, b) => a - b);
}

const CODE_RE = /^(?:0x)?[0-9A-Fa-f]{1,8}$/;
function readFaultTable(dec, dataOff, nextOff) {
  const end = (nextOff && nextOff > dataOff) ? nextOff : dec.length;
  let p = dataOff;
  const c0r = cellAt(dec, p);
  const c1r = cellAt(dec, c0r[1]);
  if (c0r[0] !== 'ORT' || c1r[0] !== 'ORTTEXT') return null;
  const c2r = cellAt(dec, c1r[1]);
  const cols = (c2r[0] === 'EREIGNIS_DTC') ? 3 : 2;
  const header = cols === 3 ? [c0r[0], c1r[0], c2r[0]] : [c0r[0], c1r[0]];
  p = cols === 3 ? c2r[1] : c1r[1];
  const rows = [];
  while (p < end) {
    const row = [];
    let q = p, bad = false;
    for (let k = 0; k < cols; k++) {
      if (q >= end) { bad = true; break; }
      const cr = cellAt(dec, q);
      row.push(cr[0]);
      q = cr[1];
    }
    if (bad) break;
    if (!CODE_RE.test(row[0])) break;
    rows.push(row);
    p = q;
  }
  return { header, cols, rows };
}

function normCode(raw) {
  const m = String(raw).match(/^(?:0x)?([0-9A-Fa-f]{1,8})$/);
  if (!m) return null;
  return '0x' + m[1].toUpperCase();
}

const EN_RE = /\b(circuit|short|open|plausib|implausible|control unit|faulty|message|missing|invalid|defective|malfunction|incorrect|out of range|too high|too low|voltage|sensor|temperature|fault|electrical|interrupt|signal|unknown|left|right|front|rear|not |error|monitoring|supply|value|above|below|threshold)\b/i;
const DE_RE = /\b(Kurzschluss|Unterbrechung|Plausibilit|Steuergerät|Botschaft|fehlerhaft|Spannung|elektrischer|festliegend|Drosselklappe|Funktion|Signal|Sensor|unbekannt|nicht |Fehler|oberhalb|unterhalb|Schwelle|links|rechts|vorne|hinten|Wert|Massnahme|Massentr|kein )\b/i;
function langOf(text) {
  const t = text || '';
  const en = EN_RE.test(t);
  const de = DE_RE.test(t);
  if (en && de) return 'mixed';
  if (en) return 'en';
  if (de) return 'de';
  return 'unknown';
}

function processFile(buf, sgbd, caveats, stats) {
  if (buf.length < 16 || buf.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) {
    caveats.push(sgbd + ': bad/absent @EDIABAS magic, skipped');
    stats.badMagic++;
    return { variant: false };
  }
  const dec = decodeBuf(buf);
  const s = dec.toString('latin1');

  // english_variant is intentionally NOT emitted: its only fields were a BMW
  // department/author code plus origin/revision, which are personal/internal
  // metadata, not car data. The useful English content is in english_dtc/english_job.
  let ecuName = null;
  try { ecuName = readInfoField(dec, s, 'ECU'); } catch { /* ignore */ }
  if (ecuName) stats.withName++;

  let dataOffs = [];
  try { dataOffs = collectDataOffsets(dec, s); } catch { dataOffs = []; }

  let dtcRows = 0, hasFort = false;
  let enCount = 0, deCount = 0, mixCount = 0;
  for (const tname of ['FORTTEXTE', 'IORTTEXTE']) {
    let no = s.indexOf(tname);
    while (no >= 0) {
      const entry = no - 8;
      const dataOff = entry >= 0 ? u32(dec, entry + 72) : 0;
      if (dataOff > 0 && dataOff < dec.length) {
        const nextOff = dataOffs.find((o) => o > dataOff);
        let tbl = null;
        try { tbl = readFaultTable(dec, dataOff, nextOff); } catch { tbl = null; }
        if (tbl && tbl.rows.length) {
          hasFort = true;
          const seen = new Set();
          for (const row of tbl.rows) {
            const code = normCode(row[0]);
            if (!code) continue;
            const text = (row[1] || '').trim();
            if (!text) continue;
            const k = tname + '|' + code + '|' + text;
            if (seen.has(k)) continue;
            seen.add(k);
            const lang = langOf(text);
            if (lang === 'en') enCount++;
            else if (lang === 'de') deCount++;
            else if (lang === 'mixed') mixCount++;
            const eventRaw = tbl.cols === 3 ? (row[2] || '').trim() : '';
            emit('english_dtc', {
              sgbd,
              code,
              location_text_en: text,
              event_dtc: /^1$/.test(eventRaw) ? 1 : (/^0$/.test(eventRaw) ? 0 : null),
              lang,
              source_table: tname,
            });
            dtcRows++;
          }
        }
      }
      no = s.indexOf(tname, no + 1);
    }
  }

  let jobRows = 0;
  const jp = s.indexOf('JOBNAME:');
  if (jp >= 0) {
    const block = s.slice(jp, jp + 200000);
    const re = /JOBNAME:([^\r\n\x00]+)[\r\n]+(?:JOBCOMMENT:([^\r\n\x00]*))?/g;
    let m;
    while ((m = re.exec(block))) {
      const job = (m[1] || '').trim();
      const desc = (m[2] || '').trim();
      if (!job || !desc) continue;
      if (langOf(desc) === 'en') {
        emit('english_job', { sgbd, job, description_en: desc });
        jobRows++;
      }
    }
  }

  let lang = 'unknown';
  if (enCount + deCount + mixCount > 0) {
    if (enCount > 0 && deCount === 0) lang = 'en';
    else if (deCount > 0 && enCount === 0) lang = 'de';
    else lang = 'mixed';
  }
  return { variant: true, dtcRows, hasFort, jobRows, lang, enCount, deCount, mixCount };
}

async function main() {
  const caveats = [];
  const stats = {
    files: 0, processed: 0, badMagic: 0, readErr: 0,
    withName: 0, withFort: 0,
    langEn: 0, langDe: 0, langMixed: 0, langUnknown: 0,
    fullyDecoded: 0, partiallyDecoded: 0,
  };

  if (!existsSync(SRC_DIR)) {
    caveats.push('source dir missing: ' + SRC_DIR);
    await closeAll();
    return finalize(stats, caveats, [], new Set());
  }

  const knownSgbd = new Set();
  if (existsSync(SGBD_VARIANT)) {
    try {
      for (const line of readFileSync(SGBD_VARIANT, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o.sgbd) knownSgbd.add(o.sgbd); } catch { /* skip */ }
      }
    } catch (e) {
      caveats.push('could not read ' + SGBD_VARIANT + ': ' + e.message);
    }
  } else {
    caveats.push('Layer-1 ecu_variant.ndjson not found at ' + SGBD_VARIANT + ' (join-coverage report skipped)');
  }

  let files;
  try {
    files = readdirSync(SRC_DIR).filter((f) => /\.prg$/i.test(f)).sort();
  } catch (e) {
    caveats.push('cannot read source dir: ' + e.message);
    await closeAll();
    return finalize(stats, caveats, [], knownSgbd);
  }
  stats.files = files.length;

  const sampleEnFiles = [];
  const seenSgbd = new Set();
  let inLayer1 = 0;
  for (const f of files) {
    const sgbd = sgbdKey(f);
    if (seenSgbd.has(sgbd)) { caveats.push(sgbd + ': duplicate sgbd key (skipped extra file ' + f + ')'); continue; }
    seenSgbd.add(sgbd);
    const full = path.join(SRC_DIR, f);
    let buf;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size === 0) { caveats.push(sgbd + ': empty/non-file, skipped'); stats.readErr++; continue; }
      if (st.size > 60000000) { caveats.push(sgbd + ': oversized ' + st.size + 'B, skipped'); stats.readErr++; continue; }
      buf = readFileSync(full);
    } catch (e) {
      caveats.push(sgbd + ': read error ' + e.message);
      stats.readErr++;
      continue;
    }
    let r;
    try {
      r = processFile(buf, sgbd, caveats, stats);
    } catch (e) {
      caveats.push(sgbd + ': PROCESS ERROR ' + e.message);
      stats.readErr++;
      continue;
    }
    if (!r.variant) continue;
    stats.processed++;
    if (knownSgbd.has(sgbd)) inLayer1++;
    if (r.hasFort) stats.withFort++;
    if (r.lang === 'en') stats.langEn++;
    else if (r.lang === 'de') stats.langDe++;
    else if (r.lang === 'mixed') stats.langMixed++;
    else stats.langUnknown++;
    if (r.hasFort) stats.fullyDecoded++;
    else stats.partiallyDecoded++;
    if (r.lang === 'en' && sampleEnFiles.length < 10) sampleEnFiles.push(sgbd + ' (' + r.enCount + ' en dtc)');
  }
  stats.variantsJoinedToLayer1 = inLayer1;

  await closeAll();
  return finalize(stats, caveats, sampleEnFiles, knownSgbd);
}

async function finalize(stats, caveats, sampleEnFiles, knownSgbd) {
  const report = {
    parser: 'english',
    sourceDir: SRC_DIR,
    outDir: OUT_DIR,
    counts,
    stats,
    knownLayer1Sgbd: knownSgbd.size,
    sampleEnglishFiles: sampleEnFiles,
    caveatsCount: caveats.length,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (caveats.length) {
    process.stderr.write('--- caveats (first 15) ---\n');
    for (const c of caveats.slice(0, 15)) process.stderr.write(c + '\n');
  }
  return { report, caveats };
}

main().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
