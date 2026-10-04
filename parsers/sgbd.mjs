#!/usr/bin/env node
// BMW Unified DB — Layer 1 (Diagnostics) parser.
// Source: ediabasx-docs-sgbd/docs/sgbd/*.md  (decoded BMW SGBD ECU-description pages)
// Output: build/sgbd/<entity>.ndjson  (NDJSON, streamed)
//
// Zero dependency. Node v22. Only node: builtins.
//
// Entities produced (per SCHEMA.md):
//   ecu_variant, job, job_arg, job_result, ecu_table, table_row, dtc, uds_services
//
// Join key `sgbd` = lowercased markdown filename without extension.

import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = (process.env.BMW_REPO_ROOT ? path.resolve(process.env.BMW_REPO_ROOT) : path.resolve(__dirname, '..', '..'));               // the BMW collection root (two levels up from parsers/)
const SRC_DIR = path.join(REPO, 'ediabasx-docs-sgbd', 'docs', 'sgbd');
const OUT_DIR = path.resolve(__dirname, '..', 'build', 'sgbd'); // bmw-unified-db/build/sgbd

mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Output writers (one NDJSON stream per entity).
// ---------------------------------------------------------------------------
const ENTITIES = [
  'ecu_variant', 'job', 'job_arg', 'job_result',
  'ecu_table', 'table_row', 'dtc', 'uds_services',
];
const writers = {};
const counts = {};
for (const e of ENTITIES) {
  writers[e] = createWriteStream(path.join(OUT_DIR, `${e}.ndjson`));
  counts[e] = 0;
}
function emit(entity, obj) {
  writers[entity].write(JSON.stringify(obj) + '\n');
  counts[entity]++;
}
function closeAll() {
  return Promise.all(ENTITIES.map((e) => new Promise((res) => writers[e].end(res))));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Known UDS service IDs (SID) we treat as "services". Used both for protocol
// detection and to know that a 2-hex byte after "UDS :" is a service vs sub-fn.
const UDS_SIDS = new Set([
  '10', '11', '14', '19', '22', '23', '24', '27', '28', '2A', '2C', '2E', '2F',
  '31', '34', '35', '36', '37', '38', '3D', '3E', '83', '84', '85', '86', '87',
]);
const UDS_SID_NAMES = {
  '10': 'DiagnosticSessionControl', '11': 'ECUReset', '14': 'ClearDiagnosticInformation',
  '19': 'ReadDTCInformation', '22': 'ReadDataByIdentifier', '23': 'ReadMemoryByAddress',
  '24': 'ReadScalingDataByIdentifier', '27': 'SecurityAccess', '28': 'CommunicationControl',
  '2A': 'ReadDataByPeriodicIdentifier', '2C': 'DynamicallyDefineDataIdentifier',
  '2E': 'WriteDataByIdentifier', '2F': 'InputOutputControlByIdentifier',
  '31': 'RoutineControl', '34': 'RequestDownload', '35': 'RequestUpload',
  '36': 'TransferData', '37': 'RequestTransferExit', '38': 'RequestFileTransfer',
  '3D': 'WriteMemoryByAddress', '3E': 'TesterPresent', '83': 'AccessTimingParameter',
  '84': 'SecuredDataTransmission', '85': 'ControlDTCSetting', '86': 'ResponseOnEvent',
  '87': 'LinkControl',
};
// Services that mark capability flags.
const FLASH_SIDS = new Set(['34', '35', '36', '37', '38']);
const DTC_SIDS = new Set(['19', '14']);

// Chassis whitelist: BMW model platform tokens. Letter + 2 digits for E/F/G/U/I,
// RR + 1 digit, K + 2 digits (motorcycle/legacy). Excludes obvious noise.
// MINI R50-R61 only: an open R\d{2} would catch Rover R40/R41, 'BDC R62' and 'R00 Software'.
const CHASSIS_RE = /\b(?:E\d{2}|F\d{2}|G\d{2}|U\d{2}|I\d{2}|RR\d|K\d{2}|R5\d|R6[01])\b/g;
function parseChassis(...texts) {
  const set = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(CHASSIS_RE)) set.add(m[0]);
  }
  return [...set].sort();
}

// Split a markdown table row "| a | b | c |" into cells. Handles escaped \|.
function splitRow(line) {
  // strip leading/trailing pipe, then split on unescaped pipes
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')) || c === '');
}

// Parse embedded UDS / DS2 / KWP service bytes out of a job description.
// Returns { services:[{service,name,did,subfn}], raw, mode, protocol }.
//
// Patterns observed in descriptions:
//   "UDS  : $22   ReadDataByIdentifier"          -> service 22
//   "UDS  : $F150 Sub-Parameter SGBD-Index"      -> did F150 (4 hex)
//   "UDS  : $02 ReadDTCByStatusMask"             -> subfn (2 hex following a service)
//   "DS2:     $1F SweepingTechnologies $F8 ..."  -> DS2 service 1F + sub F8
//   "Modus: Default" / "Mode: ..."               -> job mode
const TOKEN_RE = /\b(UDS|DS2|KWP|KW71|KWP2000|ISO)\b\s*:?\s*\$([0-9A-Fa-f]{2,4})/g;

function parseServices(desc) {
  const services = [];
  if (!desc) return { services, mode: '', protocol: null, raw: '' };

  let protocol = null;
  let raw = '';

  // Detect protocol family from explicit prefixes.
  if (/\bUDS\b\s*:/.test(desc)) protocol = 'UDS';
  else if (/\bDS2\b\s*:/.test(desc)) protocol = 'DS2';
  else if (/\bKWP2000\b|\bKWP\b\s*:/.test(desc)) protocol = 'KWP';

  // Walk protocol-tagged hex tokens left-to-right, tracking last seen SID so
  // that 2-hex bytes can be classified as service vs sub-function, and 4-hex
  // as DIDs hanging off the most recent service.
  const tagged = [...desc.matchAll(TOKEN_RE)];
  if (tagged.length) {
    raw = tagged.map((m) => `${m[1]}:$${m[2].toUpperCase()}`).join(' ');
    let lastService = null;
    for (const m of tagged) {
      const fam = m[1].toUpperCase();
      const hex = m[2].toUpperCase();
      if (hex.length === 4) {
        // DID — attach to last service if any, else stand-alone entry
        if (lastService) {
          lastService.did = lastService.did ? lastService.did + ',' + hex : hex;
        } else {
          services.push({ service: null, name: null, did: hex, subfn: null, family: fam });
        }
      } else { // 2-hex byte
        if (fam === 'UDS' && UDS_SIDS.has(hex)) {
          lastService = { service: hex, name: UDS_SID_NAMES[hex] || null, did: null, subfn: null, family: fam };
          services.push(lastService);
        } else if (lastService && lastService.family === fam) {
          // sub-function of the current service
          lastService.subfn = lastService.subfn ? lastService.subfn + ',' + hex : hex;
        } else {
          // DS2/KWP service byte or an unrecognized UDS byte: treat as its own service
          lastService = { service: hex, name: fam === 'UDS' ? (UDS_SID_NAMES[hex] || null) : null, did: null, subfn: null, family: fam };
          services.push(lastService);
        }
      }
    }
  }

  // Job mode: "Modus: X" or "Mode: X" (capture to end / next sentence-ish).
  let mode = '';
  const mm = desc.match(/\bMod(?:us|e)\s*:\s*([^\n]*?)(?:\s{2,}|$)/i);
  if (mm) mode = mm[1].trim();

  return { services, mode, protocol, raw };
}

// ---------------------------------------------------------------------------
// Per-file parse. Streams the file line by line; holds only the current
// file's lightweight structures (job/table descriptors). Table rows are
// emitted as they are read (never buffer a whole big table beyond a row).
// ---------------------------------------------------------------------------
async function parseFile(filePath, sgbd, caveats) {
  const fileKindFromName = filePath.toLowerCase().endsWith('.grp.md') ? 'GRP' : null;

  // Streaming state machine.
  // sections: top-level "## X" — INFO | Jobs | Tables | other
  // within Jobs: "### Index" (bullet list) then "### JOBNAME" blocks each with
  //   optional "#### Arguments" / "#### Results" tables.
  // within Tables: "### Index" then "### TABLENAME" with "Dimensions:" + table.
  let section = null;       // 'info' | 'jobs' | 'tables' | null
  let titleKind = null;     // 'PRG' | 'GRP' from "# name.prg"
  const info = {};          // INFO table fields
  let infoInTable = false;

  // Jobs
  const jobIndex = new Map();   // JOBNAME -> description (from index bullets)
  let curJob = null;            // current "### JOBNAME" being read in Jobs section
  let jobSub = null;            // 'args' | 'results' | null
  let jobTableMode = false;     // currently inside an args/results md table
  let jobTableSawHeader = false;
  let jobArgOrd = 0, jobResOrd = 0;
  // collect job blocks to emit after we know index descriptions
  const jobBlocks = [];         // {name, args:[], results:[]}

  // Tables
  let curTable = null;          // {name, dims, header, rowsEmitted}
  let tableSepConsumed = false; // whether the md separator row was already eaten
  const tableDescriptors = [];  // {name, rows, cols, columns} for ecu_table emit
  // DTC accumulation: we capture fault dictionary tables row-by-row directly.

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // We need cross-references for dtc env/type, but per SCHEMA the dtc entity is
  // derived from FORTTEXTE/IORTTEXTE (location). We emit dtc rows directly while
  // streaming those tables; type/env tables feed table_row anyway.
  for await (const rawLine of rl) {
    const line = rawLine.replace(/\u0000/g, ""); // strip stray NUL bytes, keep spaces

    // Title line
    if (line.startsWith('# ') && titleKind === null && section === null) {
      const t = line.slice(2).trim();
      const ext = (t.match(/\.([A-Za-z]+)\s*$/) || [, ''])[1].toLowerCase();
      if (ext === 'grp') titleKind = 'GRP';
      else if (ext === 'prg') titleKind = 'PRG';
      continue;
    }

    // Top-level section switch
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      // finalize any open job table state when leaving Jobs
      curJob = null; jobSub = null; jobTableMode = false; jobTableSawHeader = false;
      curTable = null; tableSepConsumed = false; infoInTable = false;
      const name = h2[1].trim().toLowerCase();
      if (name === 'info') section = 'info';
      else if (name === 'jobs') section = 'jobs';
      else if (name === 'tables') section = 'tables';
      else section = 'other';
      continue;
    }

    // ---------------- INFO ----------------
    if (section === 'info') {
      if (line.includes('|')) {
        const cells = splitRow(line);
        if (isSeparatorRow(cells)) { infoInTable = true; continue; }
        if (cells.length >= 2) {
          const key = cells[0].toLowerCase();
          const val = cells.slice(1).join(' | ').trim();
          if (key === 'field' && /value/i.test(val)) continue; // header
          if (key && key !== 'field') info[key] = val;
        }
      }
      continue;
    }

    // ---------------- JOBS ----------------
    if (section === 'jobs') {
      // Index bullets:  - [NAME](#anchor) - description
      const bullet = line.match(/^\s*[-*]\s*\[([^\]]+)\]\([^)]*\)\s*(?:-\s*(.*))?$/);
      if (bullet && curJob === null) {
        const jn = bullet[1].trim();
        const desc = (bullet[2] || '').trim();
        if (jn) jobIndex.set(jn, desc);
        continue;
      }

      const h3 = line.match(/^###\s+(.+?)\s*$/);
      if (h3) {
        const hn = h3[1].trim();
        if (/^index$/i.test(hn)) { curJob = null; continue; }
        // new job block
        curJob = { name: hn, args: [], results: [] };
        jobBlocks.push(curJob);
        jobSub = null; jobTableMode = false; jobTableSawHeader = false;
        jobArgOrd = 0; jobResOrd = 0;
        continue;
      }

      const h4 = line.match(/^####\s+(.+?)\s*$/);
      if (h4 && curJob) {
        const hn = h4[1].trim().toLowerCase();
        if (hn.startsWith('argument')) jobSub = 'args';
        else if (hn.startsWith('result')) jobSub = 'results';
        else jobSub = null;
        jobTableMode = false; jobTableSawHeader = false;
        continue;
      }

      // args/results markdown table rows
      if (curJob && jobSub && line.includes('|')) {
        const cells = splitRow(line);
        if (isSeparatorRow(cells)) { jobTableMode = true; jobTableSawHeader = true; continue; }
        if (cells.length >= 1) {
          // skip header row "Name | Type | Comment"
          if (!jobTableSawHeader && /^name$/i.test(cells[0])) continue;
          if (jobTableMode || jobTableSawHeader) {
            const [nm = '', ty = '', cm = ''] = cells;
            if (!nm) continue;
            if (jobSub === 'args') curJob.args.push({ name: nm, type: ty, comment: cm, ord: jobArgOrd++ });
            else curJob.results.push({ name: nm, type: ty, comment: cm, ord: jobResOrd++ });
          }
        }
        continue;
      }
      continue;
    }

    // ---------------- TABLES ----------------
    if (section === 'tables') {
      // Index bullets:  - [NAME](#anchor) (R × C)
      const tb = line.match(/^\s*[-*]\s*\[([^\]]+)\]\([^)]*\)\s*\((\d+)\s*[×x]\s*(\d+)\)/);
      if (tb && curTable === null) {
        // store declared dims by name for sanity (descriptor emitted at section read)
        // Defer emit until we read the actual "### NAME" block to also capture header.
        tableDescriptors.push({ name: tb[1].trim(), declRows: +tb[2], declCols: +tb[3], header: null, emittedRows: 0 });
        continue;
      }

      const h3 = line.match(/^###\s+(.+?)\s*$/);
      if (h3) {
        const hn = h3[1].trim();
        if (/^index$/i.test(hn)) { curTable = null; continue; }
        // find descriptor (declared in index) or create one
        let d = tableDescriptors.find((x) => x.name === hn && x.header === null && x.emittedRows === 0 && !x._opened);
        if (!d) { d = { name: hn, declRows: null, declCols: null, header: null, emittedRows: 0 }; tableDescriptors.push(d); }
        d._opened = true;
        d.header = null;
        curTable = d;
        tableSepConsumed = false;
        continue;
      }

      // Dimensions line
      const dim = line.match(/Dimensions:\s*(\d+)\s*rows?\s*[×x]\s*(\d+)\s*columns?/i);
      if (dim && curTable) {
        curTable.declRows = +dim[1];
        curTable.declCols = +dim[2];
        continue;
      }

      // Table data
      if (curTable && line.includes('|')) {
        const cells = splitRow(line);
        if (curTable.header === null) {
          // first table line is the header row
          curTable.header = cells;
          tableSepConsumed = false;
          continue;
        }
        if (!tableSepConsumed) {
          // the single markdown separator row immediately follows the header.
          // Consume it only once; any later all-dash rows are real data
          // (e.g. placeholder rows like "| -- | - | - | - |").
          tableSepConsumed = true;
          if (isSeparatorRow(cells)) continue;
          // no separator present — fall through and treat this as a data row
        }
        // data row
        if (cells.length === 1 && cells[0] === '') continue;
        const idx = curTable.emittedRows++;
        emit('table_row', { sgbd, table: curTable.name, idx, cells });

        // DTC derivation: location tables FORTTEXTE / IORTTEXTE.
        const upper = curTable.name.toUpperCase();
        if ((upper === 'FORTTEXTE' || upper === 'IORTTEXTE') && cells.length >= 2) {
          const codeRaw = cells[0];
          const hexM = codeRaw.match(/0[xX]([0-9A-Fa-f]+)/) || codeRaw.match(/^([0-9A-Fa-f]{4,6})$/);
          if (hexM) {
            const hex = hexM[1].toUpperCase();
            // text and event flag by header name: some tables put ORT/INDEX/SA/HILFE before ORTTEXT
            // or FA_BYTE after it. The code stays cells[0] so published codes do not move.
            const h = (curTable.header || []).map((x) => String(x).trim().toUpperCase());
            const ti = h.indexOf('ORTTEXT');
            const ei = h.findIndex((x) => x === 'EREIGNIS_DTC' || x === 'EREIGNIS');
            const ev = ei >= 0 ? String(cells[ei] ?? '').trim() : (h.length ? '' : (cells.length >= 3 ? cells[2].trim() : ''));
            emit('dtc', {
              sgbd,
              code: '0x' + hex,
              location_text: cells[ti >= 0 ? ti : 1],
              event_dtc: /^1$/.test(ev) ? 1 : (/^0$/.test(ev) ? 0 : null),
              source_table: upper,
            });
          }
        }
        continue;
      }
      continue;
    }
  }

  // -------- finalize file: emit ecu_variant + jobs + tables descriptors --------
  const fileKind = titleKind || fileKindFromName || 'PRG';

  // Resolve job descriptions and emit jobs/args/results + uds_services.
  let isUds = false, hasCoding = false, hasFlash = false, hasDtc = false, hasActuator = false;
  let protocol = null;

  // prefix each comma-separated hex token with '$' (e.g. "02,0C" -> "$02,$0C")
  const dollar = (v) => (v == null ? null : v.split(',').map((x) => '$' + x).join(','));

  for (const jb of jobBlocks) {
    const desc = jobIndex.get(jb.name) || '';
    const parsed = parseServices(desc);
    if (parsed.protocol === 'UDS') isUds = true;
    if (parsed.protocol && !protocol) protocol = parsed.protocol;
    else if (parsed.protocol === 'UDS') protocol = 'UDS';

    // capability flags
    const jobUpper = jb.name.toUpperCase();
    if (jobUpper.startsWith('STEUERN')) hasActuator = true;
    if (/FS_LESEN|FEHLERSPEICHER|FS_LOESCHEN/.test(jobUpper)) hasDtc = true;
    if (/COD(?:E|IER)/i.test(jb.name) || /codier/i.test(desc)) hasCoding = true;
    if (/flash/i.test(desc) || /FLASH/.test(jobUpper)) hasFlash = true;

    for (const s of parsed.services) {
      if (s.service && FLASH_SIDS.has(s.service)) hasFlash = true;
      if (s.service && DTC_SIDS.has(s.service)) hasDtc = true;
      if (s.service === '2E') hasCoding = true;
      if (s.service === '19') hasDtc = true;
      if (s.family === 'UDS') isUds = true;
      emit('uds_services', {
        sgbd, job: jb.name,
        service: s.service ? '$' + s.service : null,
        name: s.name,
        did: dollar(s.did),
        subfn: dollar(s.subfn),
        protocol: s.family || parsed.protocol,
      });
    }

    emit('job', {
      sgbd,
      name: jb.name,
      description: desc,
      mode: parsed.mode || null,
      uds_services: parsed.services.map((s) => ({
        service: s.service ? '$' + s.service : null,
        name: s.name,
        did: dollar(s.did),
        subfn: dollar(s.subfn),
      })),
      raw_services: parsed.raw || null,
    });
    for (const a of jb.args) emit('job_arg', { sgbd, job: jb.name, name: a.name, type: a.type, comment: a.comment, ord: a.ord });
    for (const r of jb.results) emit('job_result', { sgbd, job: jb.name, name: r.name, type: r.type, comment: r.comment, ord: r.ord });
  }

  // Tables: emit descriptors; flag coding tables.
  let tableCount = 0;
  for (const d of tableDescriptors) {
    if (!d._opened && d.declRows === null) continue; // index-only stray w/o block (shouldn't happen)
    tableCount++;
    const cols = (d.declCols != null) ? d.declCols : (d.header ? d.header.length : null);
    if (/COD|CODIER/i.test(d.name)) hasCoding = true;
    emit('ecu_table', {
      sgbd,
      name: d.name,
      rows: d._opened ? d.emittedRows : (d.declRows ?? 0),
      cols,
      declared_rows: d.declRows ?? null,
      columns: d.header || null,
    });
    // sanity: declared vs emitted row mismatch
    if (d._opened && d.declRows != null && d.emittedRows !== d.declRows) {
      caveats.push(`${sgbd}: table ${d.name} declared ${d.declRows} rows, parsed ${d.emittedRows}`);
    }
  }

  // protocol fallback
  if (!protocol) {
    if (isUds) protocol = 'UDS';
    else protocol = 'unknown';
  }

  const ecuName = info['ecu'] || null;
  emit('ecu_variant', {
    sgbd,
    ecu_name: ecuName,
    chassis: parseChassis(ecuName, info['comment']),
    revision: info['revision'] || null,
    comment: info['comment'] || null,
    package: info['package'] || null,
    language: info['sprache'] || null,
    protocol,
    is_uds: isUds ? 1 : 0,
    job_count: jobBlocks.length,
    table_count: tableCount,
    has_coding: hasCoding ? 1 : 0,
    has_flash: hasFlash ? 1 : 0,
    has_dtc: hasDtc ? 1 : 0,
    has_actuator: hasActuator ? 1 : 0,
    file_kind: fileKind,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const caveats = [];
  let files;
  try {
    files = readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (e) {
    console.error('FATAL: cannot read source dir', SRC_DIR, e.message);
    process.exit(1);
  }

  let processed = 0, failed = 0;
  for (const f of files) {
    const filePath = path.join(SRC_DIR, f);
    const sgbd = f.replace(/\.md$/i, '').toLowerCase();
    try {
      const st = statSync(filePath);
      if (!st.isFile() || st.size === 0) {
        caveats.push(`${sgbd}: empty or non-file, skipped`);
        // still emit a minimal ecu_variant so the join key exists
        emit('ecu_variant', {
          sgbd, ecu_name: null, chassis: [], revision: null,
          comment: null, package: null, language: null, protocol: 'unknown', is_uds: 0,
          job_count: 0, table_count: 0, has_coding: 0, has_flash: 0, has_dtc: 0,
          has_actuator: 0, file_kind: f.toLowerCase().endsWith('.grp.md') ? 'GRP' : 'PRG',
        });
        continue;
      }
      await parseFile(filePath, sgbd, caveats);
      processed++;
    } catch (e) {
      failed++;
      caveats.push(`${sgbd}: PARSE ERROR ${e.message}`);
      console.error(`[skip] ${f}: ${e.message}`);
    }
  }

  await closeAll();

  const report = {
    parser: 'sgbd',
    sourceFiles: files.length,
    processed,
    failed,
    counts,
    caveatsCount: caveats.length,
  };
  console.log(JSON.stringify(report, null, 2));
  // dump first handful of caveats for visibility
  if (caveats.length) {
    console.error('--- caveats (first 20) ---');
    for (const c of caveats.slice(0, 20)) console.error(c);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
