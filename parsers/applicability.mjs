#!/usr/bin/env node
// BMW Unified DB — Applicability layer parser.
//
// GOAL: enable "pick your car -> its ECUs + readable option codes".
//
// Outputs (NDJSON, streamed):
//   build/applicability/vehicle_ecu.ndjson
//     { chassis, ecu_group, sgbd, ecu_variant, cbd, source, source_file }
//     -> which ECU groups / SGBDs are installed per chassis (the verbau / SVT set)
//
//   build/applicability/option_code.ndjson
//     { code, code_raw, fa, meaning, keyword, chassis, kind, source, source_file }
//     -> the FA / SALAPA option-code (Sonderausstattung) dictionary:
//        option code -> human meaning.
//
// Zero dependency. Node v22. Only node: builtins. Robust: skip-and-log bad
// inputs, never crash the whole run.
//
// ---------------------------------------------------------------------------
// SOURCE FORMATS (learned by inspecting the files)
// ---------------------------------------------------------------------------
// NCS SP-DATEN lives in bmw-advanced-tools/app/NCSEXPER/DATEN/ and is E-series
// (+ R5x MINI) only. It is organised per-chassis. The relevant files:
//
//  *SGET.000 / *SGVT.000  (binary "Softing DATEN" container) — the SG-Einbau /
//      SG-Versions table: which ECU coding-files (SGBD variants) are installed,
//      keyed by an "Auftragsausdruck" boolean expression over SA option codes.
//      Container layout: a schema header defines field-groups, then after the
//      0xFFFF marker comes a DATEINAME record and then data records:
//        <2-byte record id> <1-byte group#> 0x00 <NUL-terminated field strings...> <expr>
//      group# selects the field set:
//        2 SGAUSWAHL_VM     SGNAME,CBD,UMRSG,VMG                 (4 strings)
//        3 SGAUSWAHL_SGBD   SGNAME,CBD,CABD,SGBD,UMRSG           (5 strings)
//        4 SGAUSWAHL_VMSGBD SGNAME,CBD,CABD,SGBD,UMRSG,VMG       (6 strings)
//      SGVT uses group with SG_FAM,CBD,... (versions).
//      -> sgbd     = the SGBD field (real ediabas .prg, e.g. MSV80, C_ZAEBAE)
//         ecu_group= the UMRSG field (diagnostic group abbrev, e.g. 6BMOT, ABG)
//         ecu_variant = SGNAME (e.g. MSV80, ABGB), cbd = CBD index (e.g. C08)
//
//  *ZST.000  (text, older chassis E36..E53,R50) — Zustandssteuertabelle. Carries
//      the canonical SALAPA (Sonderausstattung) dictionary. Two forms:
//        data lines:    "<code> <8hex> <16hex> <10hex> <flag> <KEYWORD> //<de meaning>"
//        comment lines: "; [H] <code> [V/N....] ... <flag> <KEYWORD> [//<de meaning>]"
//      Sections introduced by "B SALA" / "B TYP" / "B ZUSATZ".
//      <code> is a 3-4 char token: numeric "0877" (SA 877), or alnum "BE11".
//
//  *AT.000   (text, newer chassis E46,E60,E65,E70,E83,E85,E89,R56,K1X,K24,KH2)
//      Auftragsdatei. Under "//SA/LA/PS-Zeilen" it lists option codes:
//        "<T> <code>  [validity] [=xref] <KEYWORD>  //<en meaning> //<de meaning>"
//      T in {W,K,E,H,A,Z}. <code> is a 3-char SALAPA token (matches FA "$216").
//
// FA token mining (additional code->meaning + code->presence):
//   bmw-advanced-tools/.../DATEN/SELECT/VARIABLE not relevant here.
//   BMW_coding/fa.trc, BMW_coding/ASW.TRC,
//   diesel-x5m/**/*.trc (FA) and ASW-style token lists.
//   FA line:  "E70_#1010&LUSW%0B06*ZW61$1CB$220...$925-A090-EWS4"
//     -> chassis token (E70), then "$xxx" 3-char SALAPA option codes the car has.
//   ASW.TRC / *.trc token lists: one ASW keyword per line (machine labels).
//
// CANONICAL CODE FORM: SALAPA codes are normalised to "S<CODE>A" (e.g. "S216A",
// "S2SMA") with a 3-char CODE (numeric codes are right-stripped of a leading
// zero from the 4-digit ZST form: "0216"->"216"). We also keep code_raw (as
// seen) and fa ("$216"). Non-SALAPA control words (alnum 4-char TYP/ZUSATZ
// keywords like BE11/DWAH) are emitted with kind!='SA' and no S..A canonical.
// ---------------------------------------------------------------------------

import {
  readFileSync, createWriteStream, mkdirSync, readdirSync, existsSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = (process.env.BMW_REPO_ROOT ? path.resolve(process.env.BMW_REPO_ROOT) : path.resolve(__dirname, '..', '..'));               // the BMW collection root (two levels up from parsers/)
const TOOLS = path.join(REPO, 'bmw-advanced-tools', 'app');
const DATEN_DIR = path.join(TOOLS, 'NCSEXPER', 'DATEN');
const BMW_CODING = path.join(REPO, 'BMW_coding');
const DIESEL_X5M = path.join(REPO, 'diesel-x5m');
const OUT_DIR = path.resolve(__dirname, '..', 'build', 'applicability');
mkdirSync(OUT_DIR, { recursive: true });

const caveats = [];
function warn(msg) { caveats.push(msg); }

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------
const vehEcuPath = path.join(OUT_DIR, 'vehicle_ecu.ndjson');
const optCodePath = path.join(OUT_DIR, 'option_code.ndjson');
const vehWriter = createWriteStream(vehEcuPath);
const optWriter = createWriteStream(optCodePath);

let vehRows = 0;
const vehSeen = new Set();
function emitVeh(o) {
  const k = `${o.chassis}|${o.ecu_group}|${o.sgbd}|${o.ecu_variant}|${o.cbd}`;
  if (vehSeen.has(k)) return;
  vehSeen.add(k);
  vehWriter.write(JSON.stringify(o) + '\n');
  vehRows++;
}

let optRows = 0;
const optSeen = new Set();
function emitOpt(o) {
  // dedup on (canonical-or-raw code, chassis, meaning, source)
  const codeKey = o.code || o.code_raw;
  const k = `${codeKey}|${o.chassis}|${o.meaning || ''}|${o.keyword || ''}|${o.source}`;
  if (optSeen.has(k)) return;
  optSeen.add(k);
  optWriter.write(JSON.stringify(o) + '\n');
  optRows++;
}
function closeAll() {
  return Promise.all([
    new Promise((r) => vehWriter.end(r)),
    new Promise((r) => optWriter.end(r)),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CHASSIS_RE = /\b(?:E\d{2}|F\d{2}|G\d{2}|U\d{2}|I\d{2}|RR\d|K\d{2,3}|R\d{2})\b/g;
function chassisTokens(...texts) {
  const set = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).toUpperCase().matchAll(CHASSIS_RE)) set.add(m[0]);
  }
  return [...set];
}
const sgbdKey = (name) =>
  String(name || '').toLowerCase().replace(/\.(prg|grp|c[0-9a-f]{2})$/i, '').trim();

// chassis code from a SP-DATEN filename prefix, e.g. E46SGET.000 -> E46,
// K24AT.000 -> K24, R56AT.000 -> R56.
function chassisFromFilename(name) {
  const m = name.match(/^([A-Z]\d{2}|K\d{2}X?|KH\d|K\d X|RR\d|R\d{2})/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, '') : null;
}

// Normalise a SALAPA option code into the canonical S<code>A form + parts.
// Accepts raw forms: "0216" (4-digit ZST), "216" / "2SM" (3-char AT/FA), "$216".
// Returns { code, code_raw, fa, isSA } or null if it does not look like a SALAPA
// code (e.g. a 4-char alnum control word such as "BE11" / "DWAH").
function normSalapa(raw) {
  if (!raw) return null;
  let r = String(raw).trim().toUpperCase();
  r = r.replace(/^\$/, '');                 // strip FA "$" prefix
  // 4-digit numeric ZST form -> strip a single leading zero to a 3-char code
  if (/^0\d{3}$/.test(r)) r = r.slice(1);   // "0216" -> "216"
  // valid SALAPA codes are exactly 3 chars: digit followed by 2 [0-9A-Z]
  if (/^\d[0-9A-Z]{2}$/.test(r)) {
    return { code: `S${r}A`, code_raw: r, fa: `$${r}`, isSA: true };
  }
  // some ZST numeric codes are 4 digits and not zero-led (e.g. "1234" weight-cap
  // pseudo codes) — keep them raw, not SA-canonical
  return null;
}

// ---------------------------------------------------------------------------
// Encoding: SP-DATEN text files are a mix of DOS/CP850 (older E36..E53,R50) and
// Latin-1 (newer). We detect per file by counting German-letter byte hits under
// each interpretation and decode with the winner so umlauts render correctly.
// ---------------------------------------------------------------------------
const CP850_HIGH = { // high-byte -> Unicode for the German subset we see
  0x81: 'ü', 0x82: 'é', 0x84: 'ä', 0x8e: 'Ä', 0x93: 'ô', 0x94: 'ö',
  0x99: 'Ö', 0x9a: 'Ü', 0xe1: 'ß', 0xe9: 'Ú',
};
const CP850_GER = [0x81, 0x84, 0x94, 0x9a, 0xe1, 0x82];        // ü ä ö Ü ß é
const L1_GER = [0xe4, 0xf6, 0xfc, 0xdf, 0xc4, 0xd6, 0xdc, 0xe9]; // ä ö ü ß Ä Ö Ü é
function decodeText(buf) {
  let cp = 0, l1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    if (CP850_GER.includes(b)) cp++;
    if (L1_GER.includes(b)) l1++;
  }
  if (cp > l1) {
    // decode as CP850 for the German subset, else fall back to the byte's latin1
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      out += b < 0x80 ? String.fromCharCode(b) : (CP850_HIGH[b] || String.fromCharCode(b));
    }
    return out;
  }
  return buf.toString('latin1');
}

// Read a NUL-terminated Latin-1 cell at position p. Returns [string, nextPos].
function readCell(buf, p) {
  let e = buf.indexOf(0x00, p);
  if (e < 0) e = buf.length;
  return [buf.toString('latin1', p, e), e + 1];
}

// ---------------------------------------------------------------------------
// PART 1 — vehicle_ecu : parse binary *SGET.000 / *SGVT.000 (Softing DATEN)
// ---------------------------------------------------------------------------
// Field-group -> ordered field names (the strings preceding the expression).
const SGET_GROUPS = {
  2: ['SGNAME', 'CBD', 'UMRSG', 'VMG'],
  3: ['SGNAME', 'CBD', 'CABD', 'SGBD', 'UMRSG'],
  4: ['SGNAME', 'CBD', 'CABD', 'SGBD', 'UMRSG', 'VMG'],
};
// SGVT data records use group# 3 with schema SG_FAM,CBD,AUFTRAGSAUSDRUCK,INDEX,
// i.e. 2 leading strings (SG_FAM, CBD) before the expression. There is no
// separate SGBD/UMRSG, so we use SG_FAM as both ecu_variant and (lowercased) the
// group family. (group# 2 = VERSIONS_ASW version sub-records — skipped.)
const SGVT_GROUPS = {
  3: ['SG_FAM', 'CBD'],
};

const printableTok = /^[\x20-\x7E][\x20-\x7E\x80-\xFF]*$/;

// Parse one Softing DATEN container. `kind` is 'SGET' | 'SGVT'.
function parseDaten(buf, kind) {
  const out = [];
  const marker = buf.indexOf(0xff);
  // locate the 0xFFFF record-area marker
  let mi = -1;
  for (let i = Math.max(0, marker); i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xff) { mi = i; break; }
  }
  if (mi < 0) return out;
  const body = buf.subarray(mi + 2);

  const groupDef = kind === 'SGVT' ? SGVT_GROUPS : SGET_GROUPS;

  // Walk records. A record header = <2 id bytes><1 group byte in 0x02..0x04><0x00>
  // immediately followed by an uppercase field token. We read exactly the field
  // count for that group and skip the trailing expression (we only need fields).
  let p = 0;
  // skip the DATEINAME record at the very front: <tag><00><00><name><00>
  // (tag is 0x0c). Find first plausible record header instead of trusting offset.
  while (p < body.length - 4) {
    const g = body[p + 2];
    const def = groupDef[g];
    if (def && body[p + 3] === 0x00) {
      // attempt to read def.length tokens
      let q = p + 4;
      const fields = [];
      let ok = true;
      for (let f = 0; f < def.length; f++) {
        const [cell, next] = readCell(body, q);
        if (!cell || !printableTok.test(cell) || cell.length > 24) { ok = false; break; }
        fields.push(cell);
        q = next;
      }
      // first field must look like an ECU/SG name (uppercase-ish identifier)
      if (ok && /^[0-9A-Za-z][0-9A-Za-z_./-]*$/.test(fields[0])) {
        out.push({ g, fields });
        // advance past the expression to the next record. The expression ends at
        // a 0x00 0x00 (double NUL) terminator; scan for it from q.
        let r = q;
        while (r < body.length - 1) {
          if (body[r] === 0x00 && body[r + 1] === 0x00) { r += 2; break; }
          r++;
        }
        p = r;
        continue;
      }
    }
    p++;
  }
  return out;
}

function collectDatenFiles() {
  const targets = [];
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/SG(ET|VT)\.000$/i.test(e.name)) {
        const kind = /SGET\.000$/i.test(e.name) ? 'SGET' : 'SGVT';
        const chassis = chassisFromFilename(e.name);
        targets.push({ full, file: e.name, kind, chassis });
      }
    }
  };
  walk(DATEN_DIR);
  return targets;
}

function buildVehicleEcu() {
  const stats = { files: 0, records: 0, sget: 0, sgvt: 0 };
  if (!existsSync(DATEN_DIR)) { warn(`SP-DATEN dir missing: ${DATEN_DIR}`); return stats; }
  const targets = collectDatenFiles();
  // de-dup file paths: the E39 super-dir re-bundles other chassis' files that
  // also exist as top-level *.000; keep all but rely on emit() dedup. Use a
  // realpath-ish key on (chassis,file) to avoid double-counting identical files.
  const seenFile = new Set();
  for (const t of targets) {
    const fk = `${t.chassis}|${t.kind}`;
    if (seenFile.has(fk)) continue;       // one canonical SGET/SGVT per chassis
    seenFile.add(fk);
    let buf;
    try {
      const st = statSync(t.full);
      if (!st.isFile() || st.size > 20_000_000) { warn(`skip large/odd ${t.file}`); continue; }
      buf = readFileSync(t.full);
    } catch (e) { warn(`read ${t.file}: ${e.message}`); continue; }

    let recs;
    try { recs = parseDaten(buf, t.kind); }
    catch (e) { warn(`parse ${t.file}: ${e.message}`); continue; }
    if (!recs.length) {
      // distinguish a genuinely empty container (just header+DATEINAME, ~245 B)
      // from a real parse miss.
      warn(buf.length < 400 ? `empty container ${t.file}` : `no records parsed from ${t.file}`);
      continue;
    }
    stats.files++;
    stats.records += recs.length;

    for (const { g, fields } of recs) {
      const def = (t.kind === 'SGVT' ? SGVT_GROUPS : SGET_GROUPS)[g];
      if (!def) continue;
      const rec = {};
      def.forEach((name, i) => { rec[name] = fields[i]; });
      const variant = rec.SGNAME || rec.SG_FAM || null;
      const cbd = rec.CBD || null;
      // sgbd join key: ONLY the explicit SGBD field (a real ediabas description
      // file, e.g. msv80, c_zaebae). SGVT records have no SGBD field — their
      // SG_FAM is a diagnostic-group family abbreviation, NOT a description file,
      // so we leave sgbd null there rather than pollute the join key.
      const sgbdRaw = rec.SGBD || null;
      // ecu_group: UMRSG (diagnostic group abbrev); SGVT has none -> use SG_FAM
      const ecuGroup = rec.UMRSG || rec.SG_FAM || null;
      if (!variant && !sgbdRaw && !ecuGroup) continue;
      emitVeh({
        chassis: t.chassis,
        ecu_group: ecuGroup ? ecuGroup.toUpperCase() : null,
        sgbd: sgbdRaw ? sgbdKey(sgbdRaw) : null,
        ecu_variant: variant || null,
        cbd: cbd || null,
        source: 'spdaten',
        source_file: t.file,
      });
      if (t.kind === 'SGET') stats.sget++; else stats.sgvt++;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// PART 2a — option_code from *ZST.000 (text)
// ---------------------------------------------------------------------------
// data line:    "<code>[ ...]  <8hex> <16hex> <10hex> <flag> [KEYWORD] [//de]"
// comment line: "; [H ]<code> [V/N####] <8hex> <16hex> <10hex> <flag> [KEYWORD] [//de]"
// The three hex masks (8 / 16 / 10 hex digits) are the structural anchor.
const ZST_MASKS = /\b([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{16})\s+([0-9A-Fa-f]{10})\s+([01])\b/;

function parseZstLine(line, chassis, file) {
  // strip an optional leading "; " comment marker (still carries data)
  let s = line.replace(/\r$/, '');
  let isComment = false;
  if (/^;/.test(s)) { isComment = true; s = s.replace(/^;\s?/, ''); }
  if (!s.trim()) return null;
  // must contain the three masks to be a code row
  const mm = s.match(ZST_MASKS);
  if (!mm) return null;
  const before = s.slice(0, mm.index).trim();   // code [+ H/V/N tags]
  const after = s.slice(mm.index + mm[0].length); // [KEYWORD] [//de]
  // code is the FIRST token of `before`, possibly preceded by a single "H " flag
  let toks = before.split(/\s+/).filter(Boolean);
  if (toks.length && /^[HKWE]$/.test(toks[0]) && toks.length > 1) toks = toks.slice(1);
  const code = toks[0];
  if (!code) return null;
  // split keyword vs german meaning
  let keyword = null, meaning = null;
  const ci = after.indexOf('//');
  const kwPart = (ci >= 0 ? after.slice(0, ci) : after).trim();
  const dePart = ci >= 0 ? after.slice(ci + 2).trim() : '';
  if (kwPart) {
    // keyword is the first whitespace-run token block of machine label chars;
    // remaining words are an inline (un-//'d) description -> fold into meaning
    const kwTok = kwPart.split(/\s+/);
    if (/^[A-Z0-9][A-Z0-9_]*$/.test(kwTok[0])) keyword = kwTok[0];
    const rest = kwTok.slice(keyword ? 1 : 0).join(' ').trim();
    meaning = [rest, dePart].filter(Boolean).join(' — ') || null;
  } else {
    meaning = dePart || null;
  }
  return { code, keyword, meaning, isComment, chassis, file };
}

function buildOptionFromZst() {
  const stats = { files: 0, lines: 0, emitted: 0 };
  let files;
  try { files = readdirSync(DATEN_DIR).filter((n) => /ZST\.000$/i.test(n)).sort(); }
  catch (e) { warn(`ZST scan: ${e.message}`); return stats; }
  for (const f of files) {
    const chassis = chassisFromFilename(f);
    let text;
    try { text = decodeText(readFileSync(path.join(DATEN_DIR, f))); }
    catch (e) { warn(`read ${f}: ${e.message}`); continue; }
    stats.files++;
    let curSection = null;
    for (const line of text.split(/\n/)) {
      // track "B <SECTION>" markers (SALA / TYP / ZUSATZ)
      const bm = line.match(/^B\s+(SALA|TYP|ZUSATZ)\b/);
      if (bm) { curSection = bm[1]; }
      let parsed;
      try { parsed = parseZstLine(line, chassis, f); }
      catch { parsed = null; }
      if (!parsed) continue;
      stats.lines++;
      const norm = normSalapa(parsed.code);
      // determine kind: SALAPA codes -> 'SA'; TYP section codes -> 'TYPE';
      // ZUSATZ / alnum control words -> 'CTRL'
      let kind;
      if (norm && norm.isSA) kind = 'SA';
      else if (curSection === 'TYP') kind = 'TYPE';
      else kind = 'CTRL';
      // require a meaning OR keyword to be useful
      if (!parsed.meaning && !parsed.keyword) continue;
      emitOpt({
        code: norm ? norm.code : null,
        code_raw: parsed.code,
        fa: norm ? norm.fa : null,
        meaning: parsed.meaning || null,
        keyword: parsed.keyword || null,
        chassis: chassis ? [chassis] : [],
        kind,
        section: curSection || null,
        source: 'zst',
        source_file: f,
      });
      stats.emitted++;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// PART 2b — option_code from *AT.000 (text)
// ---------------------------------------------------------------------------
// "//SA/LA/PS-Zeilen" section. Lines:
//   "<T> <code>  [validity V/N####] [=xref] <KEYWORD>  //<en>  //<de>"
// T in {W,K,E,H,A,Z}. We accept all; code is the 2nd whitespace token.
const AT_LINE = /^([WKEHAZ])\s+([0-9A-Z]{3})\b(.*)$/;

function parseAtLine(line, chassis, file) {
  const s = line.replace(/\r$/, '');
  const m = s.match(AT_LINE);
  if (!m) return null;
  const [, lt, code, restAll] = m;
  // split off all //comment segments first (bilingual: en then de)
  const idx = restAll.indexOf('//');
  const head = (idx >= 0 ? restAll.slice(0, idx) : restAll);
  const commentBlock = idx >= 0 ? restAll.slice(idx) : '';
  // comments: split on "//", trim, drop empties; join distinct as meaning
  const comments = commentBlock.split('//').map((c) => c.trim()).filter(Boolean);
  // head contains: [validity V0302/N0302] [=185 xref] KEYWORD (machine label)
  const headToks = head.split(/\s+/).filter(Boolean);
  let keyword = null;
  for (const t of headToks) {
    if (/^[VN]\d{4}$/.test(t)) continue;       // validity marker
    if (/^=\d+/.test(t)) continue;             // cross-reference
    if (/^[A-Z0-9][A-Z0-9_]+$/.test(t)) { keyword = t; break; }
  }
  // meaning: prefer the joined bilingual comments; else keyword-free head words
  let meaning = comments.length ? comments.join(' — ') : null;
  return { lineType: lt, code, keyword, meaning, chassis, file };
}

function buildOptionFromAt() {
  const stats = { files: 0, emitted: 0 };
  let files;
  try { files = readdirSync(DATEN_DIR).filter((n) => /AT\.000$/i.test(n)).sort(); }
  catch (e) { warn(`AT scan: ${e.message}`); return stats; }
  for (const f of files) {
    const chassis = chassisFromFilename(f);
    let text;
    try { text = decodeText(readFileSync(path.join(DATEN_DIR, f))); }
    catch (e) { warn(`read ${f}: ${e.message}`); continue; }
    stats.files++;
    for (const line of text.split(/\n/)) {
      let p;
      try { p = parseAtLine(line, chassis, f); } catch { p = null; }
      if (!p) continue;
      if (!p.meaning && !p.keyword) continue;   // nothing useful
      const norm = normSalapa(p.code);
      emitOpt({
        code: norm ? norm.code : null,
        code_raw: p.code,
        fa: norm ? norm.fa : `$${p.code}`,
        meaning: p.meaning || null,
        keyword: p.keyword || null,
        chassis: chassis ? [chassis] : [],
        kind: norm && norm.isSA ? 'SA' : 'CTRL',
        line_type: p.lineType,
        source: 'at',
        source_file: f,
      });
      stats.emitted++;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// PART 2c — FA / ASW token mining from *.TRC / *.trc
// ---------------------------------------------------------------------------
// FA lines yield code->presence (chassis from the FA header). ASW token lists
// yield machine keyword presence (no German meaning, but useful as a label
// universe). We DO NOT invent meanings; meaning stays null unless the code can
// be cross-referenced (resolution is left to the assembly step, which can join
// option_code rows by `code`). Here we just record code + chassis + keyword.
const FA_HEADER = /^([A-Z]{1,2}\d{2,3})_#/;     // E70_# / E82_# ...
const FA_CODE_RE = /\$([0-9A-Z]{3})/g;

function findTrcFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.trc$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function buildOptionFromTrc() {
  const stats = { files: 0, faCodes: 0, aswTokens: 0 };
  const roots = [BMW_CODING, DIESEL_X5M];
  const files = [];
  for (const r of roots) { if (existsSync(r)) files.push(...findTrcFiles(r)); }
  for (const full of files) {
    const name = path.basename(full);
    let text;
    try {
      const st = statSync(full);
      if (st.size > 5_000_000) { warn(`skip large TRC ${name}`); continue; }
      text = readFileSync(full, 'latin1');
    } catch (e) { warn(`read ${name}: ${e.message}`); continue; }
    stats.files++;

    const isFA = /fa\.trc$/i.test(name) || / FA\.trc$/i.test(name) || /^FA\b/i.test(name);
    const lines = text.split(/\r?\n/);

    if (isFA) {
      // each FA line: chassis header then $codes
      for (const line of lines) {
        if (!line.includes('$')) continue;
        const hm = line.match(FA_HEADER);
        const chassis = hm ? chassisTokens(hm[1]) : chassisTokens(line);
        const ch = chassis.length ? chassis : [];
        for (const m of line.matchAll(FA_CODE_RE)) {
          const norm = normSalapa(m[1]);
          if (!norm) continue;
          emitOpt({
            code: norm.code,
            code_raw: norm.code_raw,
            fa: norm.fa,
            meaning: null,           // resolved later by joining on `code`
            keyword: null,
            chassis: ch,
            kind: 'SA',
            source: 'fa',
            source_file: name,
          });
          stats.faCodes++;
        }
      }
    } else {
      // ASW-style: one machine keyword per line (also covers ASW.TRC). Record as
      // keyword presence; chassis unknown (mixed) unless the filename carries one.
      const chassis = chassisTokens(name);
      for (const raw of lines) {
        const tok = raw.trim();
        if (!tok) continue;
        // ASW keywords are UPPER_SNAKE labels; skip lines that look like data dumps
        if (!/^[A-Z0-9][A-Z0-9_]{1,31}$/.test(tok)) continue;
        emitOpt({
          code: null,
          code_raw: null,
          fa: null,
          meaning: null,
          keyword: tok,
          chassis,
          kind: 'ASW',
          source: 'asw',
          source_file: name,
        });
        stats.aswTokens++;
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const stats = {};
  try { stats.vehicle_ecu = buildVehicleEcu(); }
  catch (e) { warn(`vehicle_ecu fatal: ${e.message}`); stats.vehicle_ecu = { error: e.message }; }
  try { stats.zst = buildOptionFromZst(); }
  catch (e) { warn(`zst fatal: ${e.message}`); stats.zst = { error: e.message }; }
  try { stats.at = buildOptionFromAt(); }
  catch (e) { warn(`at fatal: ${e.message}`); stats.at = { error: e.message }; }
  try { stats.trc = buildOptionFromTrc(); }
  catch (e) { warn(`trc fatal: ${e.message}`); stats.trc = { error: e.message }; }

  await closeAll();

  const report = {
    parser: 'applicability',
    files: [
      { entity: 'vehicle_ecu', path: vehEcuPath, rows: vehRows },
      { entity: 'option_code', path: optCodePath, rows: optRows },
    ],
    stats,
    caveats,
  };
  process.stderr.write(JSON.stringify(report, null, 2) + '\n');
  return report;
}

main().catch((e) => {
  process.stderr.write('FATAL: ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
