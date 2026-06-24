#!/usr/bin/env node
// cvt.mjs — parser for BMW NCSEXPER CVT "Codiervarianten" tables.
//
// SOURCE: bmw-advanced-tools/app/NCSEXPER/DATEN/<CHASSIS>/<X>CVT.000  (Softing "DATEN" binary)
//         plus the human-readable decode bmw-advanced-tools/.../E65CVT.000.txt (used only as a
//         validation oracle, NOT as a data source — we parse all chassis from the binaries).
//
// WHAT THIS IS: the chassis-wide CODEABLE-FUNCTION (FSW) catalog. Each entry maps an
//   FA-option boolean expression (AUFTRAGSAUSDRUCK, the FA-applicability logic) to a coding
//   function (FSW label) and a default PSW value, organised into coding blocks (GRUPPE) and
//   optionally named sub-functions (INDIVID).
//
// BINARY FORMAT (reverse-engineered, cross-checked vs E65CVT.000.txt):
//   Header: "07 00 01 00 01 00 01 01 01 63 65 ..." then a self-describing schema block listing
//     tag -> field-name/type, terminated by the marker bytes FF FF.
//   Body: a stream of length-prefixed records.  Each record:  [len:1][tag:2 LE][payload:len bytes]
//     tag 0x0000 DATEINAME         payload = filename string (NUL-terminated)
//     tag 0x0001 GRUPPE            payload = [count:1] name-string\0     -> coding block
//     tag 0x0002 INDIVID          payload = [count:1] name-string\0     -> named sub-function
//     tag 0x0003 AUFTRAGSAUSDRUCK payload = [count:1] expr-token-stream -> FA applicability
//                  expr tokens: 0x53 'S' + word(2 LE) = SALAPA ordinal S####
//                               0x2B '+' = AND, 0x2C ',' = OR, 0x21 '!' = NOT, 0x28/0x29 = ()
//     tag 0x0004 FSW_PSW          payload(4) = FSWINDEX(2 LE) PSWINDEX(2 LE)
//     tag 0x0005 FSW              payload(2) = FSWINDEX(2 LE)
//   The framing drifts on a minority of records (variable inner structure), so we parse
//   defensively: we trust well-formed [len][tag][payload] records, validate each tag's payload
//   shape, and on any inconsistency we resynchronise by scanning forward to the next plausible
//   record boundary. Bad bytes are skipped-and-logged, never fabricated.
//
// LABEL RESOLUTION (per chassis dir, scan-based — robust to the same framing):
//   SWTFSW##.dat  KEYID(2 LE) -> FSW keyword   (the coding-function name)
//   SWTPSW##.dat  KEYID(2 LE) -> PSW keyword   (the coding-value name, e.g. "aktiv","wert_01")
//   SWTASW##.dat  KEYID(2 LE) -> ASW/SALAPA name (FA option name, e.g. "E65","ARS") — best effort
//
// OUTPUT: build/coding/coding_variant.ndjson, one object per FSW_PSW / FSW entry:
//   { chassis, ecu_group, fsw_label, fsw_index, psw_options(json[]), psw_index,
//     fa_applicability, fa_applicability_named, coding_block, individ, source_file, sgbd }
//   - ecu_group / sgbd: CVT is chassis-wide (not per-ECU), so these are null here. coding_block
//     holds the GRUPPE (the real coding-block grouping present in the data).
//
// ZERO-DEP, Node v22 ESM. Streams output. Partial coverage is reported honestly.

import { readFileSync, createWriteStream, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const DATEN = join(process.env.BMW_REPO_ROOT || join(REPO, '..'), 'bmw-advanced-tools/app/NCSEXPER/DATEN');
const OUT_DIR = join(REPO, 'build', 'coding');
const OUT_FILE = join(OUT_DIR, 'coding_variant.ndjson');

// ---- tags ----
const TAG_DATEINAME = 0x0000;
const TAG_GRUPPE    = 0x0001;
const TAG_INDIVID   = 0x0002;
const TAG_AUFTRAG   = 0x0003;
const TAG_FSW_PSW   = 0x0004;
const TAG_FSW       = 0x0005;
const KNOWN_TAGS = new Set([TAG_DATEINAME, TAG_GRUPPE, TAG_INDIVID, TAG_AUFTRAG, TAG_FSW_PSW, TAG_FSW]);

const EXPR_OPS = { 0x2c: ',', 0x2b: '+', 0x21: '!', 0x28: '(', 0x29: ')' };
// An AUFTRAGSAUSDRUCK expression's first token byte is always one of: 'S' (a SALAPA code),
// '!' (negation) or '(' (a parenthesised group). e.g.  S0001 / !(S0180,S015D) / (S0001,S0002)+...
const EXPR_FIRST = new Set([0x53, 0x21, 0x28]);

const log = [];
function warn(msg) { log.push(msg); if (log.length <= 40) process.stderr.write('[warn] ' + msg + '\n'); }

function hex4(n) { return n.toString(16).padStart(4, '0').toUpperCase(); }

// Locate the body start: bytes after the FF FF schema terminator.
function bodyStart(buf) {
  const i = buf.indexOf(Buffer.from([0xff, 0xff]));
  return i < 0 ? 0 : i + 2;
}

// ---- scan-based SWT*.dat name table loader (KEYID hex -> keyword) ----
// Records are entries beginning with tag 0x0001 (SWT_EINTRAG): 01 00 <keyid:2 LE> <ascii>\0
function loadSwtTable(path) {
  const map = new Map();
  let buf;
  try { buf = readFileSync(path); } catch { return map; }
  const start = bodyStart(buf);
  let q = start;
  while (q < buf.length - 4) {
    if (buf[q] === 0x01 && buf[q + 1] === 0x00) {
      const keyid = buf.readUInt16LE(q + 2);
      let e = q + 4;
      while (e < buf.length && buf[e] !== 0x00) e++;
      const kw = buf.toString('latin1', q + 4, e);
      // keywords are upper/lower alnum + underscore + a few unit chars; require non-empty & sane
      if (kw.length > 0 && kw.length < 80 && /^[\x20-\x7e]+$/.test(kw) && !/[\x00-\x1f]/.test(kw)) {
        if (!map.has(keyid)) map.set(keyid, kw);
        q = e + 1;
        continue;
      }
    }
    q++;
  }
  return map;
}

// Find the SWT name tables that live in a chassis directory (suffix index varies per chassis).
function findSwt(dir, kind /* 'FSW' | 'PSW' | 'ASW' */) {
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  const re = new RegExp('^SWT' + kind + '\\d+\\.dat$', 'i');
  const hit = entries.find(f => re.test(f));
  return hit ? join(dir, hit) : null;
}

// ---- FA-applicability expression decoder ----
// payload[0] is an element count; the rest is the token stream.
function decodeExpr(payload) {
  let s = '';
  let i = 1;
  while (i < payload.length) {
    const b = payload[i];
    if (b === 0x53) { // 'S' + word
      if (i + 2 >= payload.length) return null;
      s += 'S' + hex4(payload.readUInt16LE(i + 1));
      i += 3;
    } else if (EXPR_OPS[b] !== undefined) {
      s += EXPR_OPS[b];
      i++;
    } else {
      return null; // not a valid expression token -> reject this candidate record
    }
  }
  return s.length ? s : null;
}

// Resolve S-ordinals in an expression to SALAPA/FA names, if we have a per-file S-map.
function nameExpr(expr, sMap) {
  if (!expr || !sMap || sMap.size === 0) return null;
  let out = '';
  let resolvedAny = false;
  for (let i = 0; i < expr.length;) {
    if (expr[i] === 'S' && /[0-9A-F]/.test(expr[i + 1] || '')) {
      const code = parseInt(expr.slice(i + 1, i + 5), 16);
      const nm = sMap.get(code);
      if (nm) { out += nm; resolvedAny = true; } else out += expr.slice(i, i + 5);
      i += 5;
    } else { out += expr[i]; i++; }
  }
  return resolvedAny ? out : null;
}

// ---- core sequential CVT parser ----
// Returns array of raw entries: {gruppe, individ, expr, kind:'FSW_PSW'|'FSW', fsw, psw}
// Also builds the per-file S-ordinal -> SALAPA name map from single-token AUFTRAG records when
// an ASW table is available (kept best-effort; the raw S-expression is always emitted).
function parseCvt(buf) {
  const start = bodyStart(buf);
  const entries = [];
  let gruppe = null, individ = null, expr = null;
  let p = start;
  let resyncs = 0, malformed = 0;

  const len = buf.length;
  while (p + 3 <= len) {
    const recLen = buf[p];
    const tag = buf.readUInt16LE(p + 1);

    // A record must fit, have a known tag, and a payload consistent with that tag.
    const payStart = p + 3;
    const payEnd = payStart + recLen;
    let ok = false;

    if (KNOWN_TAGS.has(tag) && payEnd <= len) {
      const payload = buf.subarray(payStart, payEnd);
      if (tag === TAG_FSW_PSW && recLen === 4) {
        entries.push({ gruppe, individ, expr, kind: 'FSW_PSW',
          fsw: payload.readUInt16LE(0), psw: payload.readUInt16LE(2) });
        ok = true;
      } else if (tag === TAG_FSW && recLen === 2) {
        entries.push({ gruppe, individ, expr, kind: 'FSW', fsw: payload.readUInt16LE(0), psw: null });
        ok = true;
      } else if (tag === TAG_AUFTRAG && recLen >= 3 && EXPR_FIRST.has(payload[1])) {
        const e = decodeExpr(payload);
        if (e) { expr = e; ok = true; }
      } else if (tag === TAG_GRUPPE && recLen >= 2) {
        const name = readCountedName(payload);
        if (name) { gruppe = name; individ = null; expr = null; ok = true; }
      } else if (tag === TAG_INDIVID && recLen >= 2) {
        const name = readCountedName(payload);
        if (name) { individ = name; ok = true; }
      } else if (tag === TAG_DATEINAME && recLen >= 2) {
        ok = true; // filename record; nothing to store
      }
    }

    if (ok) {
      p = payEnd;
    } else {
      // Resync: advance one byte and look for the next plausible record start.
      malformed++;
      p = resyncForward(buf, p + 1);
      resyncs++;
      if (resyncs > buf.length) break; // safety
    }
  }
  return { entries, resyncs, malformed };
}

// A counted name payload: [count:1] ascii-name (optionally NUL-terminated).
function readCountedName(payload) {
  let end = payload.length;
  const nul = payload.indexOf(0x00, 1);
  if (nul >= 1) end = nul;
  const name = payload.toString('latin1', 1, end);
  if (name.length > 0 && name.length < 120 && /^[\x20-\x7e]+$/.test(name)) return name;
  return null;
}

// Move forward to the next byte position that looks like a valid [len][tag] header for a
// known tag whose payload shape is plausible. Conservative: only the strongest signals.
function resyncForward(buf, from) {
  const len = buf.length;
  for (let p = from; p + 3 <= len; p++) {
    const recLen = buf[p];
    const tag = buf.readUInt16LE(p + 1);
    if (!KNOWN_TAGS.has(tag)) continue;
    if (p + 3 + recLen > len) continue;
    if (tag === TAG_FSW_PSW && recLen === 4) return p;
    if (tag === TAG_FSW && recLen === 2) return p;
    if (tag === TAG_AUFTRAG && recLen >= 3 && EXPR_FIRST.has(buf[p + 4])) return p;
    if ((tag === TAG_GRUPPE || tag === TAG_INDIVID) && recLen >= 2 && buf[p + 4] >= 0x20 && buf[p + 4] < 0x7f) return p;
  }
  return len; // nothing left
}

// ---- discover CVT files across all chassis dirs ----
function findCvtFiles() {
  const found = [];
  let top;
  try { top = readdirSync(DATEN); } catch (e) { warn('cannot read DATEN: ' + e.message); return found; }
  for (const name of top) {
    const full = join(DATEN, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      let sub;
      try { sub = readdirSync(full); } catch { continue; }
      for (const f of sub) {
        if (/CVT\.000$/i.test(f)) found.push({ path: join(full, f), dir: full, file: f });
      }
    }
  }
  // de-dup by basename: prefer the copy living in its own chassis dir (e.g. E46/E46CVT.000 over E39/E46CVT.000)
  const byName = new Map();
  for (const c of found) {
    const chassis = c.file.replace(/CVT\.000$/i, '').toUpperCase();
    const ownDir = basename(c.dir).toUpperCase() === chassis;
    const prev = byName.get(c.file.toUpperCase());
    if (!prev || (ownDir && !prev.ownDir)) byName.set(c.file.toUpperCase(), { ...c, chassis, ownDir });
  }
  return [...byName.values()].sort((a, b) => a.chassis.localeCompare(b.chassis));
}

// ---- main ----
function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const out = createWriteStream(OUT_FILE);

  const cvtFiles = findCvtFiles();
  process.stderr.write(`[info] found ${cvtFiles.length} CVT files\n`);

  let totalRows = 0;
  const chassisSet = new Set();
  const fswLabelSet = new Set();
  const perChassis = [];
  let unresolvedFsw = 0, resolvedFsw = 0;

  for (const cvt of cvtFiles) {
    let buf;
    try { buf = readFileSync(cvt.path); } catch (e) { warn(`read fail ${cvt.path}: ${e.message}`); continue; }

    // Per-chassis label tables.
    const fswTablePath = findSwt(cvt.dir, 'FSW');
    const pswTablePath = findSwt(cvt.dir, 'PSW');
    const aswTablePath = findSwt(cvt.dir, 'ASW');
    const fswMap = fswTablePath ? loadSwtTable(fswTablePath) : new Map();
    const pswMap = pswTablePath ? loadSwtTable(pswTablePath) : new Map();
    const aswMap = aswTablePath ? loadSwtTable(aswTablePath) : new Map();

    const { entries, resyncs, malformed } = parseCvt(buf);

    // Build S-ordinal -> SALAPA name map from single-token AUFTRAG comments is not possible from
    // the binary alone; SALAPA ordinals are file-local indices, not ASW KEYIDs. We therefore do
    // NOT guess names from aswMap by ordinal. fa_applicability_named is left null unless a future
    // mapping is available. (We keep aswMap loaded for coverage stats only.)
    void aswMap;

    let fileRows = 0;
    for (const e of entries) {
      const fswLabel = fswMap.get(e.fsw) || null;
      if (fswLabel) { resolvedFsw++; fswLabelSet.add(fswLabel); } else { unresolvedFsw++; }

      const pswOptions = [];
      if (e.psw !== null && e.psw !== undefined) {
        const pswLabel = pswMap.get(e.psw) || null;
        pswOptions.push({ psw_index: hex4(e.psw), psw_label: pswLabel });
      }

      const rec = {
        chassis: cvt.chassis,
        ecu_group: null,                 // CVT is chassis-wide, not per-ECU
        fsw_label: fswLabel,
        fsw_index: hex4(e.fsw),
        psw_options: pswOptions,
        psw_index: e.psw !== null && e.psw !== undefined ? hex4(e.psw) : null,
        fa_applicability: e.expr || null,
        fa_applicability_named: null,
        coding_block: e.gruppe || null,
        individ: e.individ || null,
        source_file: cvt.file,
        sgbd: null,                      // no SGBD join key resolvable from CVT
      };
      out.write(JSON.stringify(rec) + '\n');
      fileRows++;
    }

    totalRows += fileRows;
    chassisSet.add(cvt.chassis);
    perChassis.push({ chassis: cvt.chassis, rows: fileRows, entries: entries.length,
      resyncs, malformed, fswTable: fswTablePath ? basename(fswTablePath) : null,
      pswTable: pswTablePath ? basename(pswTablePath) : null });
    process.stderr.write(`[info] ${cvt.chassis}: ${fileRows} rows (resyncs=${resyncs}, fswTbl=${fswMap.size}, pswTbl=${pswMap.size})\n`);
  }

  out.end();

  return new Promise((resolve) => {
    out.on('finish', () => {
      const report = {
        totalRows, distinctChassis: chassisSet.size, distinctFswLabels: fswLabelSet.size,
        resolvedFsw, unresolvedFsw, perChassis,
      };
      resolve(report);
    });
  });
}

main().then((report) => {
  process.stderr.write('\n=== REPORT ===\n' + JSON.stringify(report, null, 2) + '\n');
  // persist a tiny machine-readable summary alongside output for the orchestrator
  process.stdout.write(JSON.stringify(report) + '\n');
}).catch((e) => {
  process.stderr.write('FATAL ' + e.stack + '\n');
  process.exit(1);
});
