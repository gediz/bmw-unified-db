#!/usr/bin/env node
// ext_generic_dtc.mjs — zero-dep Node ESM parser (Node v22)
//
// External data layer: GENERIC OBD-II DIAGNOSTIC TROUBLE CODES (ISO 15031 / SAE J2012).
// This is the standard P/C/B/U code dictionary that the BMW-specific SGBD corpus
// lacks. Joins to our world via the same 5-char DTC token (e.g. P0301) that appears
// in scan-tool output and in many BMW UDS "read DTC" responses for the OBD subset.
//
// INPUT: the committed snapshot external/generic-dtc/obd-trouble-codes.csv (retrieved 2026-06-24) of
//   github.com/mytrile/obd-trouble-codes  (MIT, (c) 2014 Dimitar Kostov)
//   raw CSV: .../master/obd-trouble-codes.csv  -> "CODE","Description" (RFC-4180)
//   We prefer the CSV over the JSON: the upstream JSON reuses the first row's
//   keys ("P0100" / first description) as the object keys for EVERY row, so the
//   keys are noise — only the *values* carry the real code+desc. The CSV is the
//   unambiguous canonical form (col0 = code, col1 = description).
//
// FALLBACKS, only if that file is missing (not reproducible): fetch the upstream master CSV, then
// JSON; if both are unreachable:
//   Reconstruct the well-known *standardized* SAE J2012 generic ranges we are
//   confident about (P0xxx core powertrain block, etc.) and mark those rows with
//   source="reconstructed:ISO15031/SAEJ2012". We NEVER fabricate BMW-specific or
//   otherwise vehicle-specific codes — structural/standard data only.
//
// OUTPUT (streaming NDJSON): build/external/generic_dtc.ndjson
//   { code, description, category, is_generic, source }
//     code        e.g. "P0301"          (uppercased, validated [PCBU][0-9A-F]{4})
//     description e.g. "Cylinder 1 Misfire Detected"
//     category    one of P|C|B|U        (first char of code)
//     is_generic  1 if the 2nd char is "0" or "2" (manufacturer-independent
//                 ISO/SAE ranges), else 0 (manufacturer-specific 1/3 ranges).
//     source      "mytrile/obd-trouble-codes@master (MIT)" for fetched rows,
//                 or "reconstructed:ISO15031/SAEJ2012" for fallback rows.
//
// Join conventions kept: codes are uppercase ASCII tokens. (No hex addresses or
// chassis tokens are involved in this layer.)
//
// Robustness: full RFC-4180 CSV parse (handles ""-escaped quotes and quoted
// commas); skip-and-log malformed lines; partial coverage is fine.

import { createWriteStream, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const OUT_PATH =
  path.resolve(import.meta.dirname, "..", "build", "external", "generic_dtc.ndjson");

// Upstream raw endpoints (CSV preferred; JSON kept as a secondary attempt).
const SRC_CSV =
  "https://raw.githubusercontent.com/mytrile/obd-trouble-codes/master/obd-trouble-codes.csv";
const SRC_JSON =
  "https://raw.githubusercontent.com/mytrile/obd-trouble-codes/master/obd-trouble-codes.json";
const SOURCE_TAG_FETCHED = "mytrile/obd-trouble-codes@master (MIT)";
const SOURCE_TAG_RECON = "reconstructed:ISO15031/SAEJ2012";

// The committed snapshot under external/generic-dtc/ is the input, so the run is reproducible offline.
// The network endpoints above are only a fallback if that file is missing.
const LOCAL_CSV_CANDIDATES = [
  path.join(
    path.resolve(import.meta.dirname, "..", "external", "generic-dtc"),
    "obd-trouble-codes.csv",
  ),
];

const log = [];
const warn = (m) => log.push(m);

// ---- tiny NDJSON writer ----
function openWriter(absPath) {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const ws = createWriteStream(absPath, { flags: "w" });
  let n = 0;
  const samples = [];
  return {
    write(obj) {
      ws.write(JSON.stringify(obj) + "\n");
      n++;
      if (samples.length < 5) samples.push(obj);
    },
    async close() {
      await new Promise((res) => ws.end(res));
      return { rows: n, samples };
    },
    get rows() {
      return n;
    },
  };
}

// ---- code classification (ISO 15031 / SAE J2012) ----
const CODE_RE = /^[PCBU][0-9A-F]{4}$/;

function categoryOf(code) {
  return code[0]; // P|C|B|U
}

// is_generic: 1 when the 2nd character is "0" or "2" => the manufacturer-
// independent (SAE/ISO-defined) ranges; 0 for "1"/"3" (manufacturer-specific).
function isGenericOf(code) {
  const d = code[1];
  return d === "0" || d === "2" ? 1 : 0;
}

function normCode(raw) {
  return String(raw).trim().toUpperCase();
}

// =====================================================================
// RFC-4180 CSV parser (zero-dep). Yields arrays of fields per record.
// Handles: quoted fields, ""-escaped quotes, commas/newlines inside quotes.
// =====================================================================
function* parseCsvRecords(text) {
  let field = "";
  let record = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  let started = false; // whether the current record has any content yet

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    record.push(field);
    field = "";
    const out = record;
    record = [];
    started = false;
    return out;
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    // not in quotes
    if (c === '"') {
      inQuotes = true;
      started = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      started = true;
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue; // swallow CR; LF handles record end
    }
    if (c === "\n") {
      if (started || field.length > 0 || record.length > 0) {
        yield pushRecord();
      } else {
        // blank line
        field = "";
        record = [];
        started = false;
      }
      i++;
      continue;
    }
    field += c;
    started = true;
    i++;
  }
  // trailing record without newline
  if (started || field.length > 0 || record.length > 0) {
    yield pushRecord();
  }
}

// =====================================================================
// Fetch helper — uses global fetch (Node 18+). Returns text or null.
// =====================================================================
async function tryFetchText(url) {
  if (typeof fetch !== "function") {
    warn(`fetch unavailable in this runtime; cannot retrieve ${url}`);
    return null;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      warn(`fetch ${url} -> HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    warn(`fetch ${url} failed: ${e.message}`);
    return null;
  }
}

function readLocalCsv() {
  for (const p of LOCAL_CSV_CANDIDATES) {
    if (existsSync(p)) {
      try {
        const txt = readFileSync(p, "utf8");
        if (txt && txt.trim().length) {
          warn(`using local CSV copy: ${p}`);
          return { text: txt, from: p };
        }
      } catch (e) {
        warn(`could not read local CSV ${p}: ${e.message}`);
      }
    }
  }
  return null;
}

// =====================================================================
// Emit rows from CSV text (col0=code, col1=description).
// =====================================================================
function emitFromCsv(text, writer, sourceTag) {
  let ok = 0,
    bad = 0,
    rec = 0;
  const seen = new Set();
  for (const fields of parseCsvRecords(text)) {
    rec++;
    if (fields.length < 2) {
      bad++;
      warn(`CSV record ${rec}: <2 fields -> skipped: ${JSON.stringify(fields).slice(0, 80)}`);
      continue;
    }
    const code = normCode(fields[0]);
    const description = String(fields[1]).trim();
    // tolerate a header row like CODE,Description
    if (code === "CODE" || code === "DTC") {
      warn(`CSV record ${rec}: header row skipped`);
      continue;
    }
    if (!CODE_RE.test(code)) {
      bad++;
      warn(`CSV record ${rec}: malformed code "${code}" -> skipped`);
      continue;
    }
    if (!description) {
      bad++;
      warn(`CSV record ${rec}: empty description for ${code} -> skipped`);
      continue;
    }
    if (seen.has(code)) {
      warn(`CSV record ${rec}: duplicate code ${code} -> skipped (keeping first)`);
      continue;
    }
    seen.add(code);
    writer.write({
      code,
      description,
      category: categoryOf(code),
      is_generic: isGenericOf(code),
      source: sourceTag,
    });
    ok++;
  }
  return { ok, bad, rec };
}

// =====================================================================
// JSON fallback parse (upstream JSON has noisy keys; values are real).
// Each element looks like { "P0100": "<realCode>", "<firstDesc>": "<realDesc>" }.
// We take values[0] as code and values[1] as description.
// =====================================================================
function emitFromJson(text, writer, sourceTag) {
  let ok = 0,
    bad = 0;
  let arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    warn(`JSON parse failed: ${e.message}`);
    return { ok, bad, rec: 0 };
  }
  if (!Array.isArray(arr)) {
    warn(`JSON root is not an array -> cannot use`);
    return { ok, bad, rec: 0 };
  }
  const seen = new Set();
  let rec = 0;
  for (const obj of arr) {
    rec++;
    if (!obj || typeof obj !== "object") {
      bad++;
      continue;
    }
    const vals = Object.values(obj);
    if (vals.length < 2) {
      bad++;
      continue;
    }
    const code = normCode(vals[0]);
    const description = String(vals[1]).trim();
    if (!CODE_RE.test(code) || !description || seen.has(code)) {
      if (!seen.has(code)) bad++;
      continue;
    }
    seen.add(code);
    writer.write({
      code,
      description,
      category: categoryOf(code),
      is_generic: isGenericOf(code),
      source: sourceTag,
    });
    ok++;
  }
  return { ok, bad, rec };
}

// =====================================================================
// FALLBACK reconstruction — only the well-established standardized P0
// powertrain block (SAE J2012 / ISO 15031). Short, structural, generic.
// Used ONLY when no fetched/local data is available, so the layer is never
// empty. Marked with SOURCE_TAG_RECON. No BMW/vehicle-specific values.
// =====================================================================
function emitReconstructed(writer) {
  // A conservative slice of the universally-published SAE J2012 generic P0
  // misfire + fuel/air + sensor families. These exact strings are part of the
  // public standard and appear identically across every OBD-II reference.
  const RECON = [
    ["P0100", "Mass or Volume Air Flow Circuit Malfunction"],
    ["P0101", "Mass or Volume Air Flow Circuit Range/Performance Problem"],
    ["P0102", "Mass or Volume Air Flow Circuit Low Input"],
    ["P0103", "Mass or Volume Air Flow Circuit High Input"],
    ["P0105", "Manifold Absolute Pressure/Barometric Pressure Circuit Malfunction"],
    ["P0110", "Intake Air Temperature Circuit Malfunction"],
    ["P0115", "Engine Coolant Temperature Circuit Malfunction"],
    ["P0120", "Throttle/Pedal Position Sensor/Switch A Circuit Malfunction"],
    ["P0130", "O2 Sensor Circuit Malfunction (Bank 1 Sensor 1)"],
    ["P0171", "System Too Lean (Bank 1)"],
    ["P0172", "System Too Rich (Bank 1)"],
    ["P0174", "System Too Lean (Bank 2)"],
    ["P0175", "System Too Rich (Bank 2)"],
    ["P0300", "Random/Multiple Cylinder Misfire Detected"],
    ["P0301", "Cylinder 1 Misfire Detected"],
    ["P0302", "Cylinder 2 Misfire Detected"],
    ["P0303", "Cylinder 3 Misfire Detected"],
    ["P0304", "Cylinder 4 Misfire Detected"],
    ["P0305", "Cylinder 5 Misfire Detected"],
    ["P0306", "Cylinder 6 Misfire Detected"],
    ["P0307", "Cylinder 7 Misfire Detected"],
    ["P0308", "Cylinder 8 Misfire Detected"],
    ["P0325", "Knock Sensor 1 Circuit Malfunction (Bank 1 or Single Sensor)"],
    ["P0335", "Crankshaft Position Sensor A Circuit Malfunction"],
    ["P0340", "Camshaft Position Sensor Circuit Malfunction"],
    ["P0420", "Catalyst System Efficiency Below Threshold (Bank 1)"],
    ["P0430", "Catalyst System Efficiency Below Threshold (Bank 2)"],
    ["P0440", "Evaporative Emission Control System Malfunction"],
    ["P0500", "Vehicle Speed Sensor Malfunction"],
    ["P0505", "Idle Control System Malfunction"],
    ["P0600", "Serial Communication Link Malfunction"],
    ["P0700", "Transmission Control System Malfunction"],
  ];
  let ok = 0;
  for (const [code, description] of RECON) {
    const c = normCode(code);
    if (!CODE_RE.test(c)) continue;
    writer.write({
      code: c,
      description,
      category: categoryOf(c),
      is_generic: isGenericOf(c),
      source: SOURCE_TAG_RECON,
    });
    ok++;
  }
  warn(
    `FALLBACK: emitted ${ok} reconstructed standardized P0 rows (SAE J2012 / ISO 15031). ` +
      `Network/local source was unavailable.`,
  );
  return { ok };
}

// =====================================================================
// main
// =====================================================================
async function main() {
  const w = openWriter(OUT_PATH);

  let usedSource = null; // "csv-local" | "csv-fetch" | "json-fetch" | "reconstructed"
  let stats = { ok: 0, bad: 0, rec: 0 };

  // 1) Prefer a local CSV copy (reproducible), then fetch CSV, then fetch JSON.
  const local = readLocalCsv();
  if (local) {
    stats = emitFromCsv(local.text, w, SOURCE_TAG_FETCHED);
    usedSource = "csv-local";
  } else {
    const csvText = await tryFetchText(SRC_CSV);
    if (csvText) {
      stats = emitFromCsv(csvText, w, SOURCE_TAG_FETCHED);
      usedSource = "csv-fetch";
    } else {
      const jsonText = await tryFetchText(SRC_JSON);
      if (jsonText) {
        stats = emitFromJson(jsonText, w, SOURCE_TAG_FETCHED);
        usedSource = "json-fetch";
      }
    }
  }

  // 2) If nothing was produced, reconstruct the standardized block.
  let reconCount = 0;
  if (w.rows === 0) {
    const r = emitReconstructed(w);
    reconCount = r.ok;
    usedSource = "reconstructed";
  }

  const { rows, samples } = await w.close();

  // category / is_generic tallies for validation
  const report = {
    parser: "ext_generic_dtc",
    used_source: usedSource,
    files: [{ entity: "generic_dtc", path: OUT_PATH, rows }],
    totals: {
      generic_dtc: rows,
      parsed_ok: stats.ok || reconCount,
      skipped_bad: stats.bad || 0,
      records_seen: stats.rec || 0,
      reconstructed_rows: reconCount,
    },
    caveats: log,
    sampleRows: { generic_dtc: samples },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
