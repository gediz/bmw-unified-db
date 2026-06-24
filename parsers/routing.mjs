#!/usr/bin/env node
// BMW Unified DB — Layer 2 (Routing / phone book) parser.
//
// Goal (per SCHEMA.md): for each ECU/SGBD recover
//   ecu_group    (e.g. G_AIRBAG)
//   diag_address (hex, = ID_SG_ADR)
//   sgbd_index   (= ID_SGBD_INDEX)
//   chassis      (BMW platform tokens)
//   source       ('prg' | 'spdaten')
//
// Output: build/routing/routing.ndjson  (NDJSON, streamed, one row per sgbd+address)
//
// Zero dependency. Node v22. Only node: builtins.
//
// ---------------------------------------------------------------------------
// FORMAT NOTES (learned by inspecting the binaries + reference loader)
// ---------------------------------------------------------------------------
// EDIABAS SGBD files (.prg / .grp) start with the ASCII magic
//   "@EDIABAS OBJECT\0" and the remainder of the file is obfuscated with a
//   single-byte XOR key 0xF7 (verified: decoding the body yields the readable
//   INFO block "ECU/ORIGIN/REVISION/..." and the table cell strings).
//
// The diagnostic-address "phone book" is NOT stored as a per-ECU constant
// inside each .prg (ID_SG_ADR there is just a job/result identifier, computed
// at runtime). Instead BMW ships the master address<->SGBD<->group mapping as
// a set of lookup TABLES inside ONE shared SGBD: T_GRTB.PRG ("externe Tabelle
// ZuordnungsTabelle"). Every G_*.grp group file references it
// ("table ZuordnungsTabelleUDS in T_GRTB.PRG"). It contains 5 tables:
//   ZUORDNUNGSTABELLE            (legacy KWP/DS2)  cols: ADR_VAR_DIAG SGBD GRUPPE BAUREIHE STEUERGERAET
//   ZUORDNUNGSTABELLEMOTORRAD                      cols: ADR_VAR_DIAG SGBD GRUPPE STEUERGERAET
//   ZUORDNUNGSTABELLEUDS         (UDS / F-series)  cols: ADR_INDEX SGBD GRUPPE BAUREIHE STEUERGERAET VERANTWORTUNG
//   ZUORDNUNGSTABELLEHYBRID                        cols: ADR_INDEX SGBD GRUPPE BAUREIHE STEUERGERAET VERANTWORTUNG
//   ZUORDNUNGSTABELLEMOTORRADUDS                   cols: ADR_INDEX SGBD GRUPPE STEUERGERAET
//
// Inside the decoded binary the table content is a contiguous run of
// NUL-terminated Latin-1 cells: first the column-name cells, then rows*cols
// data cells, table after table.
//
// The address column encodes both ID_SG_ADR and ID_SGBD_INDEX:
//   ADR_INDEX     "AA IIIIII"     -> diag_address=0xAA, sgbd_index=0xIIIIII   (UDS $22 F150)
//   ADR_VAR_DIAG  "AA ---- VVVV"  -> diag_address=0xAA, sgbd_index=0xVVVV     (legacy variant id)
//
// SECONDARY SOURCE: NCS SP-DATEN  *SGET.000  (SG-Einbau-Tabelle). Textual rows
//   "<idx> SGNAME CABDIDX A_<cabd> <C_/SGBD> <GROUP> <expr>" map an SGBD coding
//   file to an ECU group + chassis (from the file/dir name). No numeric diag
//   address is present there, but it covers older KWP/DS2 ECUs that are not in
//   the UDS phone book — emitted with source='spdaten', diag_address=null.

import { readFileSync, createWriteStream, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');               // the BMW collection root (two levels up from parsers/)
const TOOLS = path.join(REPO, 'bmw-advanced-tools', 'app');
const ECU_DIRS = [
  path.join(TOOLS, 'EDIABAS', 'ECU'),
  path.join(TOOLS, 'EDIABAS', 'ECU', 'EnglishEcu'),
  path.join(TOOLS, 'EDIABAS', 'EnglishEcu'),
];
const DATEN_DIR = path.join(TOOLS, 'NCSEXPER', 'DATEN');
const OUT_DIR = path.resolve(__dirname, '..', 'build', 'routing');
mkdirSync(OUT_DIR, { recursive: true });

const XOR_KEY = 0xf7;
const MAGIC = '@EDIABAS OBJECT';

// ---------------------------------------------------------------------------
// Output writer
// ---------------------------------------------------------------------------
const outPath = path.join(OUT_DIR, 'routing.ndjson');
const writer = createWriteStream(outPath);
let rowCount = 0;
// dedup key so we don't emit identical (sgbd, group, address, index, source) twice
const seen = new Set();
function emit(obj) {
  const k = `${obj.sgbd}|${obj.ecu_group}|${obj.diag_address}|${obj.sgbd_index}|${obj.source}`;
  if (seen.has(k)) return;
  seen.add(k);
  writer.write(JSON.stringify(obj) + '\n');
  rowCount++;
}
function closeOut() {
  return new Promise((res) => writer.end(res));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CHASSIS_RE = /\b(?:E\d{2}|F\d{2}|G\d{2}|U\d{2}|I\d{2}|RR\d|K\d{2}|R\d{2})\b/g;
function chassisFrom(...texts) {
  const set = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).toUpperCase().matchAll(CHASSIS_RE)) set.add(m[0]);
  }
  return [...set];
}
const sgbdKey = (name) => String(name).toLowerCase().replace(/\.(prg|grp)$/i, '').trim();

// Decode an EDIABAS SGBD file body. Returns a Buffer of the de-XOR'd bytes
// (the 16-byte magic header stays as-is at the front; everything else is
// XOR 0xF7). We keep it simple: XOR the whole buffer except the leading magic.
function decodeSgbd(buf) {
  // Validate magic; first 16 bytes are "@EDIABAS OBJECT\0" in plaintext.
  const head = buf.subarray(0, MAGIC.length).toString('latin1');
  if (head !== MAGIC) return null;
  const out = Buffer.allocUnsafe(buf.length);
  // leading magic + a small plaintext header region: XOR everything, the magic
  // region XORs to garbage but we never read it as strings (we search for known
  // ASCII tokens which only appear in the decoded body).
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ XOR_KEY;
  return out;
}

// Read a NUL-terminated Latin-1 cell at position p. Returns [string, nextPos].
function readCell(buf, p) {
  let e = buf.indexOf(0x00, p);
  if (e < 0) e = buf.length;
  return [buf.toString('latin1', p, e), e + 1];
}

// Recognised table column-header names (all the ones used by T_GRTB tables).
const COL_NAMES = new Set([
  'ADR_VAR_DIAG', 'ADR_INDEX', 'SGBD', 'GRUPPE', 'BAUREIHE', 'STEUERGERAET', 'VERANTWORTUNG',
]);

// Parse the address column cell into { diag_address, sgbd_index }.
// Forms:  "AA IIIIII"        (UDS / hybrid)   -> addr=AA, index=IIIIII
//         "AA ---- VVVV"     (legacy variant) -> addr=AA, index=VVVV
//         "?? ????" etc.     -> nulls (placeholder rows)
function parseAddrCell(cell) {
  const toks = cell.trim().split(/\s+/).filter(Boolean);
  const isHex = (s) => /^[0-9A-Fa-f]+$/.test(s);
  let addr = null, index = null;
  if (toks.length >= 1 && isHex(toks[0])) addr = toks[0].toUpperCase();
  // index = last hex-looking token that isn't the address itself / dashes
  for (let i = toks.length - 1; i >= 1; i--) {
    if (isHex(toks[i])) { index = toks[i].toUpperCase(); break; }
  }
  return {
    diag_address: addr ? '0x' + addr.replace(/^0+(?=.)/, '') : null,
    sgbd_index: index ? '0x' + index.replace(/^0+(?=.)/, '') : null,
  };
}

// ---------------------------------------------------------------------------
// SOURCE 1 — T_GRTB.PRG master phone book (binary, XOR-decoded)
// ---------------------------------------------------------------------------
// Find every table header block in the decoded cell stream, then read its data
// rows. A header block = >=3 consecutive cells that are all known COL_NAMES and
// that starts with an address column (ADR_VAR_DIAG or ADR_INDEX). The data for
// that table runs until the next header block (or end of the printable region).
function parseGrtb(decoded, caveats) {
  const rows = [];
  // Build a flat index of cells with their start positions, but only across the
  // contiguous region that contains the first table header onward. We scan the
  // whole buffer for cells; rows are grouped by detected header blocks.
  // 1) locate all header-block starts.
  const addrLeads = ['ADR_VAR_DIAG\0', 'ADR_INDEX\0'];
  const headerStarts = [];
  for (const lead of addrLeads) {
    const leadBuf = Buffer.from(lead, 'latin1');
    let from = 0;
    while (true) {
      const i = decoded.indexOf(leadBuf, from);
      if (i < 0) break;
      headerStarts.push(i);
      from = i + 1;
    }
  }
  headerStarts.sort((a, b) => a - b);
  if (headerStarts.length === 0) {
    caveats.push('T_GRTB: no ADR_VAR_DIAG/ADR_INDEX header blocks found');
    return rows;
  }

  // For each header block, read its column names, then read data cells until the
  // next header start.
  for (let h = 0; h < headerStarts.length; h++) {
    const start = headerStarts[h];
    const limit = (h + 1 < headerStarts.length) ? headerStarts[h + 1] : decoded.length;
    // read column names
    const cols = [];
    let p = start;
    while (p < limit) {
      const [cell, next] = readCell(decoded, p);
      if (COL_NAMES.has(cell)) { cols.push(cell); p = next; }
      else break;
    }
    if (cols.length < 3 || (cols[0] !== 'ADR_VAR_DIAG' && cols[0] !== 'ADR_INDEX')) continue;
    const colCount = cols.length;
    const idxOf = (name) => cols.indexOf(name);
    const ci = {
      addr: 0,                       // first column is always the address col
      sgbd: idxOf('SGBD'),
      grp: idxOf('GRUPPE'),
      br: idxOf('BAUREIHE'),
      sg: idxOf('STEUERGERAET'),
    };
    // read data cells in groups of colCount
    const cells = [];
    while (p < limit) {
      const [cell, next] = readCell(decoded, p);
      if (next > limit + 1) break;
      cells.push(cell);
      p = next;
    }
    // group
    const nRows = Math.floor(cells.length / colCount);
    for (let r = 0; r < nRows; r++) {
      const row = cells.slice(r * colCount, r * colCount + colCount);
      const addrCell = row[ci.addr] || '';
      const sgbdName = ci.sgbd >= 0 ? (row[ci.sgbd] || '') : '';
      const group = ci.grp >= 0 ? (row[ci.grp] || '') : '';
      const baureihe = ci.br >= 0 ? (row[ci.br] || '') : '';
      const steuer = ci.sg >= 0 ? (row[ci.sg] || '') : '';
      // skip placeholder / blank rows
      if (!sgbdName || sgbdName === '?' || /\?\?/.test(addrCell)) continue;
      // SGBD filenames are plain identifiers (letters/digits/_); reject anything
      // with control chars or odd punctuation (guards against a misaligned row
      // produced by a false header-block split).
      if (!/^[0-9A-Za-z][0-9A-Za-z_]*$/.test(sgbdName)) continue;
      // the address column must look like a real address record, not stray data
      if (!/^[0-9A-Fa-f?]{1,4}(\s|$)/.test(addrCell.trim())) continue;
      const { diag_address, sgbd_index } = parseAddrCell(addrCell);
      rows.push({
        sgbd: sgbdKey(sgbdName),
        ecu_group: group || null,
        diag_address,
        sgbd_index,
        chassis: chassisFrom(baureihe, steuer),
        ecu_name: steuer || null,
        addr_raw: addrCell,
        source: 'prg',
        source_file: 'T_GRTB.PRG',
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// SOURCE 2 — G_*.grp group filenames -> the ecu_group catalogue.
// The .grp filename IS the group name (G_AIRBAG, G_MOTOR, ...). We decode each
// group file's INFO to grab the human ECU name; the group itself confirms the
// set of valid ecu_group tokens used to back-fill / validate.
// (We do NOT invent addresses here — addresses come from T_GRTB.)
// ---------------------------------------------------------------------------
function collectGroupFiles(caveats) {
  const groups = new Map(); // GROUPNAME -> { ecu_name }
  for (const dir of ECU_DIRS) {
    if (!existsSync(dir)) continue;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^G_.*\.grp$/i.test(name)) continue;
      const full = path.join(dir, name);
      let ecuName = null;
      try {
        const st = statSync(full);
        if (st.isFile() && st.size < 5_000_000) {
          const dec = decodeSgbd(readFileSync(full));
          if (dec) {
            const m = dec.toString('latin1').match(/ECU:([^\n\r\x00]+)/);
            if (m) ecuName = m[1].trim();
          }
        }
      } catch (e) {
        caveats.push(`group ${name}: ${e.message}`);
      }
      const gname = name.replace(/\.grp$/i, '').toUpperCase();
      if (!groups.has(gname)) groups.set(gname, { ecu_name: ecuName });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// SOURCE 3 — NCS SP-DATEN *SGET.000 -> (sgbd coding file, ecu_group, chassis)
// Row layout (whitespace separated, after a binary index prefix byte):
//   <idx> SGNAME CABD A_<cabd> <SGBD_coding> <GROUP> <auftrags-expr...>
// We treat the token after the A_* CABD as the coding SGBD and the next token
// (uppercase group abbreviation, NOT starting with A_/C_) as the ecu_group.
// Chassis comes from the chassis-dir/file name (E46, E60, ...).
// ---------------------------------------------------------------------------
function parseSget(caveats) {
  const out = [];
  if (!existsSync(DATEN_DIR)) {
    caveats.push(`SP-DATEN dir missing: ${DATEN_DIR}`);
    return out;
  }
  // gather *SGET.000 in DATEN root and in per-chassis subdirs
  const targets = [];
  const walk = (dir, chassisHint) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, e.name.toUpperCase());
      } else if (/SGET\.000$/i.test(e.name)) {
        // chassis prefix from filename, e.g. E46SGET.000 -> E46
        const m = e.name.match(/^([A-Z]\d{2,3}|K\d+X|RR\d)/i);
        targets.push({ full, chassis: chassisHint || (m ? m[1].toUpperCase() : null), file: e.name });
      }
    }
  };
  walk(DATEN_DIR, null);

  for (const t of targets) {
    let text;
    try {
      text = readFileSync(t.full, 'latin1');
    } catch (e) {
      caveats.push(`SGET ${t.file}: ${e.message}`);
      continue;
    }
    // The records are separated by binary index bytes; split on runs of control
    // chars and parse token sequences. Look for the pattern
    //   <SGNAME> <C##> A_<cabd> <SGBD> <GROUP>
    // Tokens are space-separated printable runs.
    const tokens = text.split(/[\x00-\x1f\x7f-\xa0]+/).map((s) => s.trim()).filter(Boolean);
    // re-tokenise across spaces
    const flat = [];
    for (const seg of tokens) for (const w of seg.split(/\s+/)) if (w) flat.push(w);
    // scan for A_* anchors: SGNAME=flat[i-2], CABDidx=flat[i-1], A_=flat[i],
    // SGBD=flat[i+1], GROUP=flat[i+2]
    for (let i = 0; i < flat.length; i++) {
      if (!/^A_[0-9A-Za-z_]+$/.test(flat[i])) continue;
      const sgname = flat[i - 2];
      const cabdIdx = flat[i - 1];
      const sgbdCoding = flat[i + 1];
      const group = flat[i + 2];
      if (!sgname || !sgbdCoding || !group) continue;
      // cabdIdx looks like C07/C29/C0C; group is an uppercase abbrev token
      if (!/^[A-Z]?C?[0-9A-F]{2,3}$/i.test(cabdIdx)) continue;
      // group: short uppercase abbreviation (ABG, ASC, MK60, 4BMOT ...)
      if (!/^[0-9A-Z][0-9A-Z_]{0,11}$/.test(group)) continue;
      // coding SGBD must be a clean filename token, not another A_/C_ anchor noise
      if (/^A_/.test(sgbdCoding)) continue;
      if (!/^[0-9A-Za-z][0-9A-Za-z_]*$/.test(sgbdCoding)) continue;
      // The "phone-book" group is the abbreviation; we prefix G_ where it maps
      // to an EDIABAS group, else keep the raw abbreviation.
      emitCandidate(out, {
        sgbd: sgbdKey(sgbdCoding),
        ecu_group: group.toUpperCase(),
        chassis: chassisFrom(t.chassis, sgname),
        source: 'spdaten',
        source_file: t.file,
        sgname,
      });
    }
  }
  return out;
}
function emitCandidate(arr, o) { arr.push(o); }

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const caveats = [];
  const stats = { grtb_rows: 0, grtb_tables: 0, spdaten_rows: 0, groups: 0, prg_emitted: 0, spdaten_emitted: 0 };

  // --- Source 1: T_GRTB.PRG ---
  let grtbPath = null;
  for (const dir of ECU_DIRS) {
    const cand = path.join(dir, 'T_GRTB.PRG');
    if (existsSync(cand)) { grtbPath = cand; break; }
  }
  let grtbRows = [];
  if (grtbPath) {
    try {
      const dec = decodeSgbd(readFileSync(grtbPath));
      if (!dec) {
        caveats.push('T_GRTB.PRG: bad magic, could not decode');
      } else {
        grtbRows = parseGrtb(dec, caveats);
        stats.grtb_rows = grtbRows.length;
      }
    } catch (e) {
      caveats.push(`T_GRTB.PRG: ${e.message}`);
    }
  } else {
    caveats.push('T_GRTB.PRG not found in any ECU dir');
  }

  // --- Source 2: group catalogue (for ecu_name enrichment + validation) ---
  let groups = new Map();
  try {
    groups = collectGroupFiles(caveats);
    stats.groups = groups.size;
  } catch (e) {
    caveats.push(`group scan: ${e.message}`);
  }

  // Emit phone-book rows (source=prg). Enrich ecu_name from group catalogue when
  // the table's STEUERGERAET text was empty.
  for (const r of grtbRows) {
    let ecuName = r.ecu_name;
    if (!ecuName && r.ecu_group && groups.has(r.ecu_group)) {
      ecuName = groups.get(r.ecu_group).ecu_name || null;
    }
    emit({
      sgbd: r.sgbd,
      ecu_group: r.ecu_group,
      diag_address: r.diag_address,
      sgbd_index: r.sgbd_index,
      chassis: r.chassis,
      ecu_name: ecuName,
      addr_raw: r.addr_raw,
      source: 'prg',
      source_file: r.source_file,
    });
    stats.prg_emitted++;
  }

  // Build the set of sgbd already covered by the binary phone book (with an
  // address) so SP-DATEN only back-fills NEW sgbd that have no PRG routing.
  const prgSgbd = new Set(grtbRows.map((r) => r.sgbd));

  // --- Source 3: SP-DATEN SGET ---
  let sget = [];
  try {
    sget = parseSget(caveats);
    stats.spdaten_rows = sget.length;
  } catch (e) {
    caveats.push(`SGET parse: ${e.message}`);
  }
  for (const s of sget) {
    // Only back-fill sgbd not already routed from the binary phone book.
    if (prgSgbd.has(s.sgbd)) continue;
    emit({
      sgbd: s.sgbd,
      ecu_group: s.ecu_group,
      diag_address: null,      // not recoverable from SGET
      sgbd_index: null,
      chassis: s.chassis,
      ecu_name: null,
      addr_raw: null,
      source: 'spdaten',
      source_file: s.source_file,
    });
    stats.spdaten_emitted++;
  }

  await closeOut();

  // ---- validation / reporting ----
  const withAddr = grtbRows.filter((r) => r.diag_address).length;
  const report = {
    parser: 'routing',
    outPath,
    rows: rowCount,
    stats,
    coverage: {
      prg_unique_sgbd: prgSgbd.size,
      prg_rows_with_diag_address: withAddr,
      spdaten_backfilled_sgbd: stats.spdaten_emitted,
    },
    caveats,
  };
  // Print to stderr so stdout stays clean if piped.
  process.stderr.write(JSON.stringify(report, null, 2) + '\n');
  return report;
}

main().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
