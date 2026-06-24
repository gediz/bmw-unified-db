#!/usr/bin/env node
// measurement.mjs — extract the INPA live-data / measurement layer from readable
// INPA source scripts (*.ips). Zero-dependency Node ESM (Node v22).
//
// Source format (verified by inspection): INPA `.ips` files are ISO-8859-1 (Latin-1)
// C-like "Nacharbeitssource" text with CRLF line endings. They carry the same
// screen/measurement definitions as the compiled `.ipo` bytecode, but in readable text.
//
// The display layer is built from a small vocabulary of API/host calls:
//   SCREEN s_name() { ... }                     // a measurement/status screen
//   INPAapiJob(sgbd,"JOB",args,"")              // selects the EDIABAS job to run
//   INPAapiResultAnalog(var,"RESULT",satz)      // reads a numeric result   (also Int/Long)
//   INPAapiResultDigital(var,"RESULT",satz)     // reads a boolean result
//   INPAapiResultText(var,"RESULT",satz,"")     // reads a string result
//   ftextout("Label", row, col, ...)            // host: draw a label / unit string
//   text(row, col, "Label")                     // host: draw a label / unit string
//   analogout(var[*m_km|*m_c], r,c, min,max, minOk,maxOk, "fmt")  // numeric formatter
//   digitalout(var, r,c, "trueText","falseText")                  // boolean formatter
//   realtostring(var, "fmt", out)                                 // numeric formatter
//
// Unit-conversion factors m_c / a_c (Grad C -> Fahrenheit, z = x*m_c + a_c) and
// m_km (km -> miles, z = x*m_km) are declared at the top of each file (default 1.0,
// flipped for US display). When a result value is emitted as `var*m_km` / `var*m_c`,
// we record that symbolic scale; otherwise scale/offset are null. NOTE: the true
// raw->engineering numeric scaling lives in the SGBD (.prg) result definitions, not
// in the .ips — the .ips only carries label, unit, job, result and display format.
//
// Output: build/measurement/measurement.ndjson
//   { sgbd, screen, job, result, label, unit, scale, offset, source_file, type, format }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC_DIR = (process.env.BMW_REPO_ROOT || path.resolve(import.meta.dirname, '..', '..')) + '/bmw-advanced-tools/app/EC-APPS/INPA/SGDAT';
const OUT_DIR = path.join(REPO, 'build', 'measurement');
const OUT_FILE = path.join(OUT_DIR, 'measurement.ndjson');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Known unit tokens that may appear unbracketed in ftextout/text.
const UNIT_WORDS = new Set([
  'Volt', 'V', 'mV', 'mVolt', 'uV', 'µV', 'mueV', 'Ohm', 'kOhm', 'A', 'mA', 'uA', 'µA',
  'bar', 'mbar', 'hPa', 'kPa', 'Pa', 'psi', 'Nm', 'mg', 'mg/Hub', 'mg/s', 'kg', 'kg/h',
  'g/h', 'g/s', 'l/h', 'l', 'km', 'km/h', 'm/s', 'm/s*s', 'mph', 'Grad', 'Grad C',
  'Grad/sec', 'Grad/s', '°', '°C', '°F', '%', 'ms', 's', 'sec', 'min', 'Sek', 'h',
  '1/min', 'U/min', '1/s', 'rpm', 'digits', 'Inkr', 'mVolt/g', 'mVolt/bar', 'mV/bar',
  'mV/g', 'mueVolt/bar', 'mueV/bar',
]);

function looksLikeUnit(s) {
  if (!s) return false;
  const t = s.trim();
  const m = t.match(/^\[\s*(.+?)\s*\]$/);
  if (m) {
    if (m[1] === 'EXTRA') return false; // INPA layout marker, not a unit
    return true;
  }
  if (UNIT_WORDS.has(t)) return true;
  if (t.length <= 10 && /[°%]|\/(min|s|h|sec|bar|g|Hub)|^m?bar$|Ohm|Volt/.test(t)) return true;
  return false;
}

function cleanUnit(s) {
  const t = s.trim();
  const m = t.match(/^\[\s*(.+?)\s*\]$/);
  return m ? m[1].trim() : t;
}

// pull all double-quoted string literals out of an argument list, in order.
function quotedArgs(argstr) {
  const matches = argstr.match(/"(?:[^"\\]|\\.)*"/g) || [];
  return matches.map((q) => q.slice(1, -1));
}

// detect unit-conversion scale/offset from an output expression (the var part).
function detectScale(expr) {
  let scale = null, offset = null;
  if (/\bm_km\b/.test(expr)) scale = 'm_km';                 // km -> miles
  if (/\bm_c\b/.test(expr)) { scale = 'm_c'; offset = 'a_c'; } // C -> F, x*m_c + a_c
  return { scale, offset };
}

// Honor C comments so we never emit screens the firmware never compiles.
// Removes // line comments and /* */ block comments, preserving string literals
// and newline positions (so line numbers stay aligned).
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let state = 0; // 0=code 1=line-comment 2=block-comment 3=string
  while (i < n) {
    const c = text[i];
    const d = i + 1 < n ? text[i + 1] : '';
    if (state === 0) {
      if (c === '/' && d === '/') { state = 1; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 2; out += '  '; i += 2; continue; }
      if (c === '"') { state = 3; out += c; i++; continue; }
      out += c; i++;
    } else if (state === 1) {
      if (c === '\n') { state = 0; out += c; i++; } else { out += (c === '\r' ? c : ' '); i++; }
    } else if (state === 2) {
      if (c === '*' && d === '/') { state = 0; out += '  '; i += 2; continue; }
      out += (c === '\n' || c === '\r' ? c : ' '); i++;
    } else {
      out += c;
      if (c === '"') state = 0;
      i++;
    }
  }
  return out;
}

// regex sources (string form so we can build fresh /g instances cheaply)
const SCREEN_RE = /\bSCREEN\s+([A-Za-z_]\w*)\s*\(/;
const JOB_RE = /\bINPAapiJob\s*\(([^)]*)\)/;
const RESULT_RE = /\bINPAapiResult(Analog|Int|Long|Digital|Text|Binary|Sets)\s*\(([^)]*)\)/;
const RESULT_TEST_RE = /\bINPAapiResult(?:Analog|Int|Long|Digital|Text|Binary|Sets)\s*\(/;
// ftextout("Label", ROW, COL, ...) — col is the 3rd arg
const FTEXT_SRC = 'ftextout\\s*\\(\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)';
// text(ROW, COL, "Label") — col is the 2nd arg
const TEXT_SRC = 'text\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\)';
// analogout(var, ROW, COL, min,max, minOk,maxOk, "fmt") — col is the 3rd arg
const ANALOGOUT_RE = /\banalogout\s*\(\s*([^,]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,[^,]*,[^,]*,[^,]*,[^,]*,\s*"([^"]*)"/;
const REALSTR_RE = /\brealtostring\s*\(\s*([^,]+)\s*,\s*"([^"]*)"/;
const DIGOUT_RE = /\bdigitalout\s*\(\s*([^,]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/;

// Drawn label/unit candidates on a line, each with its screen column so we can
// associate the right label/unit to a result in two-column screens.
function drawnStringsOnLine(ln, lineNo) {
  const out = [];
  for (const m of ln.matchAll(new RegExp(FTEXT_SRC, 'g'))) {
    out.push({ text: m[1], col: Number(m[3]), row: Number(m[2]), line: lineNo });
  }
  for (const m of ln.matchAll(new RegExp(TEXT_SRC, 'g'))) {
    out.push({ text: m[3], col: Number(m[2]), row: Number(m[1]), line: lineNo });
  }
  return out;
}

// ---------------------------------------------------------------------------
// per-file extraction
// ---------------------------------------------------------------------------

function extractFile(filePath, emit, log) {
  const base = path.basename(filePath);
  const sgbdSelf = base.replace(/\.[^.]+$/, '').toLowerCase();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'latin1');
  } catch (e) {
    log(`READ_FAIL ${base}: ${e.message}`);
    return { records: 0, screens: 0, sgbdSelf };
  }
  const lines = stripComments(raw).split(/\r?\n/);

  let recCount = 0;
  const screenSet = new Set();
  const seen = new Set();

  let curScreen = null;
  let curJob = null;
  let curJobTarget = null;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    const sm = ln.match(SCREEN_RE);
    if (sm) {
      curScreen = sm[1];
      curJob = null;
      curJobTarget = null;
      screenSet.add(`${sgbdSelf}::${curScreen}`);
    }

    const jm = ln.match(JOB_RE);
    if (jm) {
      const args = jm[1];
      const q = quotedArgs(args);
      const firstArgRaw = args.split(',')[0].trim();
      if (/^"/.test(firstArgRaw)) {
        curJobTarget = q[0] || null;   // explicit SGBD literal (e.g. UTILITY)
        curJob = q[1] || null;
      } else {
        curJobTarget = null;           // variable target == this screen's own ECU
        curJob = q[0] || null;
      }
    }

    const rm = ln.match(RESULT_RE);
    if (rm && curScreen) {
      const kind = rm[1];
      const rargs = rm[2];
      const q = quotedArgs(rargs);
      if (q.length === 0) {
        log(`SKIP_COMPUTED_RESULT ${base} screen=${curScreen} line=${i + 1}: ${ln.trim().slice(0, 80)}`);
        continue;
      }
      const result = q[0];
      if (!result) continue;

      const recvVar = rargs.split(',')[0].trim();

      // --- 1) find this result's formatter (analogout/digitalout/realtostring) and
      //        the screen COLUMN it draws to, so two-column screens associate cleanly.
      const WIN_BACK = 8, WIN_FWD = 6;
      let scale = null, offset = null, format = null;
      let outCol = null;          // column the value is drawn at
      let digTexts = null;        // two-state texts from digitalout
      for (let j = i; j <= Math.min(lines.length - 1, i + WIN_FWD); j++) {
        if (j !== i && RESULT_TEST_RE.test(lines[j])) break;
        const a = lines[j].match(ANALOGOUT_RE);
        if (a && a[1].includes(recvVar)) {
          format = a[4]; outCol = Number(a[3]);
          ({ scale, offset } = detectScale(a[1]));
          break;
        }
        const dg = lines[j].match(DIGOUT_RE);
        if (dg && dg[1].includes(recvVar)) {
          outCol = Number(dg[3]);
          if (dg[4] || dg[5]) digTexts = `${dg[4].trim()}|${dg[5].trim()}`;
          break;
        }
        const r = lines[j].match(REALSTR_RE);
        if (r && r[1].includes(recvVar)) {
          format = r[2];
          ({ scale, offset } = detectScale(r[1]));
          // realtostring has no column; the column comes from the following text/ftextout
          break;
        }
      }

      // --- 2) collect drawn strings around the result, each with column/row/line.
      //        cand entries carry `side` (-1 before, +1 after the result line).
      const cand = [];
      for (let j = Math.max(0, i - WIN_BACK); j < i; j++) {
        if (RESULT_TEST_RE.test(lines[j])) cand.length = 0; // don't bleed across results
        for (const s of drawnStringsOnLine(lines[j], j)) { s.side = -1; cand.push(s); }
      }
      for (const s of drawnStringsOnLine(ln, i)) { s.side = -1; cand.push(s); } // result line
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + WIN_FWD); j++) {
        if (RESULT_TEST_RE.test(lines[j])) break;
        for (const s of drawnStringsOnLine(lines[j], j)) { s.side = 1; cand.push(s); }
      }

      // anchor column: the formatter's draw column; else the nearest label's column.
      if (outCol === null) {
        for (let k = cand.length - 1; k >= 0; k--) {
          if (cand[k].side === -1 && !looksLikeUnit(cand[k].text)) { outCol = cand[k].col; break; }
        }
        if (outCol === null && cand.length) outCol = cand[0].col;
      }
      const SAME_COL = 6;
      const sameCol = (c) => outCol === null || Math.abs(c - outCol) <= SAME_COL;
      const lineDist = (s) => Math.abs(s.line - i);

      // --- 3) unit: same-column unit string nearest (by line) to the result.
      let unit = null;
      if (digTexts) {
        unit = digTexts;
      } else {
        let best = null, bestD = Infinity;
        for (const s of cand) {
          if (!looksLikeUnit(s.text) || !sameCol(s.col)) continue;
          const d = lineDist(s);
          if (d < bestD) { best = cleanUnit(s.text); bestD = d; }
        }
        if (!best) { // fallback: any unit in window
          let bd = Infinity;
          for (const s of cand) {
            if (!looksLikeUnit(s.text)) continue;
            const d = lineDist(s);
            if (d < bd) { best = cleanUnit(s.text); bd = d; }
          }
        }
        unit = best;
      }

      // --- 4) label: same-column, non-unit, non-title string nearest (by line) to the
      //        result. Title rows (row<=1) are deprioritized; "before" ties win over
      //        "after" only when distances are equal.
      const isLabel = (s) => {
        const t = s.text.trim();
        return t && t !== ':' && t !== '/' && !looksLikeUnit(t) && !/^<.*>/.test(t);
      };
      let label = null, bestScore = Infinity;
      for (const s of cand) {
        if (!isLabel(s) || !sameCol(s.col)) continue;
        // score: line distance, plus penalties for title rows and far columns.
        let score = lineDist(s) * 2;
        if (s.row <= 1) score += 100;        // screen title row — almost never the label
        if (s.side === 1) score += 1;         // mild preference for labels above the value
        if (score < bestScore) { bestScore = score; label = s.text.trim(); }
      }
      if (label === null) { // last resort: nearest non-title label of any column
        let bd = Infinity;
        for (const s of cand) {
          if (!isLabel(s) || s.row <= 1) continue;
          const d = lineDist(s);
          if (d < bd) { bd = d; label = s.text.trim(); }
        }
      }

      const typeMap = {
        Analog: 'analog', Int: 'int', Long: 'long',
        Digital: 'digital', Text: 'text', Binary: 'binary', Sets: 'set',
      };
      const outType = typeMap[kind] || kind.toLowerCase();
      // text/binary results are strings, not measured quantities: a bracketed/word
      // "unit" near them belongs to a neighbouring numeric value, so drop it unless it
      // is an explicit two-state meaning from digitalout.
      if ((outType === 'text' || outType === 'binary') && !digTexts) unit = null;

      const targetSgbd = curJobTarget ? curJobTarget.toLowerCase() : sgbdSelf;
      const dedupKey = `${targetSgbd}|${curScreen}|${curJob}|${result}|${label}|${unit}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      emit({
        sgbd: targetSgbd,
        screen: curScreen,
        job: curJob,
        result,
        label: label || null,
        unit: unit || null,
        scale,
        offset,
        source_file: base,
        type: outType,
        format: format || null,
      });
      recCount++;
    }
  }

  return { records: recCount, screens: screenSet.size, sgbdSelf };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = fs.createWriteStream(OUT_FILE, { encoding: 'utf8' });
  const logs = [];
  const log = (m) => logs.push(m);

  let files;
  try {
    files = fs.readdirSync(SRC_DIR).filter((f) => /\.ips$/i.test(f)).sort();
  } catch (e) {
    console.error(JSON.stringify({ error: `cannot read SRC_DIR: ${e.message}` }));
    process.exit(1);
  }

  let totalRecords = 0;
  let totalScreens = 0;
  const ecuSet = new Set();
  const perFile = [];

  for (const f of files) {
    const fp = path.join(SRC_DIR, f);
    let r;
    try {
      r = extractFile(fp, (rec) => {
        out.write(JSON.stringify(rec) + '\n');
        ecuSet.add(rec.sgbd);
      }, log);
    } catch (e) {
      log(`PARSE_FAIL ${f}: ${e.message}`);
      continue;
    }
    totalRecords += r.records;
    totalScreens += r.screens;
    perFile.push({ file: f, records: r.records, screens: r.screens });
  }

  out.end();
  out.on('finish', () => {
    const report = {
      filesScanned: files.length,
      totalRecords,
      totalScreens,
      ecusCovered: ecuSet.size,
      skipLogCount: logs.length,
      topFiles: perFile.sort((a, b) => b.records - a.records).slice(0, 12),
      sampleSkips: logs.slice(0, 8),
    };
    console.error(JSON.stringify(report, null, 2));
  });
}

main();
