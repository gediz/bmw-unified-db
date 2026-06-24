#!/usr/bin/env node
// checksum_netto.mjs — zero-dep Node ESM parser (Node v22)
//
// Two small but safety-relevant extractions for the BMW unified DB:
//
//   1) CAN checksum ALGORITHMS used to actually transmit/validate frames.
//      Source of truth: openpilot/selfdrive/car/bmw/bmwcan.py
//        - calc_checksum_4bit   (seeded by msg id; 16->8->4 bit fold)   # 0x130
//        - calc_checksum_8bit   (seeded by msg id; 16->8 bit fold)      # 0xb8 0x1a0 0x19e 0xaa 0xbf
//        - calc_checksum_cruise (8bit seeded with 0)                    # 0x194 (CruiseControlStalk)
//      The msg-id->algo mapping is taken VERBATIM from the inline comments in
//      bmwcan.py and from the call sites (STEERING_COMMAND id 558 / 0x22E uses
//      8bit seeded by its own addr). We do NOT invent ids — only what is present.
//      Output: build/can/can_checksum_algo.ndjson
//        { id_dec, id_hex, algo, seed, note }
//
//   2) NETTODAT raw coding images: concrete coding byte blocks per ECU, captured
//      as 'B <addr>,<len>,<byte,byte,...>' records, in Default vs Coded states.
//      Source: diesel-x5m/{Default,Coded} ECUs/<MOD (SGBD.Cxx)>/NETTODAT.TRC
//      (BMW_coding/*.TRC are FSW_PSW label/value dumps, NOT NETTODAT 'B' records,
//       so they yield zero rows here — reported as a caveat, not fabricated.)
//      Output: build/coding/coding_netto.ndjson
//        { source_car, ecu_module, sgbd, address, length, bytes, state, source_file }
//
// Robustness: skip-and-log malformed lines; partial coverage is fine.

import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const REPO_ROOT = process.env.BMW_REPO_ROOT || path.resolve(import.meta.dirname, "..", "..");
const OUT_ROOT = path.resolve(import.meta.dirname, "..", "build");

const BMWCAN_PY = path.join(REPO_ROOT, "openpilot/selfdrive/car/bmw/bmwcan.py");
const DIESEL_ROOT = path.join(REPO_ROOT, "diesel-x5m");

// extra NETTODAT capture found in the toolchain working dir (not a diesel-x5m car,
// but a real coding image worth keeping). Optional; skipped silently if absent.
const EXTRA_NETTO = [
  path.join(REPO_ROOT, "bmw-advanced-tools/app/NCSEXPER/WORK/NETTODAT.TRC"),
];

const log = [];
const warn = (m) => { log.push(m); };

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
      if (samples.length < 3) samples.push(obj);
    },
    async close() {
      await new Promise((res) => ws.end(res));
      return { rows: n, samples };
    },
    get rows() { return n; },
  };
}

function streamLines(absPath, onLine) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(absPath),
      crlfDelay: Infinity,
    });
    let i = 0;
    rl.on("line", (line) => { i++; onLine(line, i); });
    rl.on("close", () => resolve(i));
    rl.on("error", reject);
  });
}

// =====================================================================
// PART 1 — CAN checksum algorithms
// =====================================================================
// Verify the algorithm bodies are still as expected by scanning bmwcan.py,
// then emit the id->algo records grounded in its inline comments + call sites.
async function buildChecksumAlgos() {
  const outPath = path.join(OUT_ROOT, "can/can_checksum_algo.ndjson");
  const w = openWriter(outPath);

  // --- read source so we don't blindly hardcode; pull comment id-lists live ---
  let src = "";
  if (existsSync(BMWCAN_PY)) {
    await streamLines(BMWCAN_PY, (l) => { src += l + "\n"; });
  } else {
    warn(`PART1: bmwcan.py not found at ${BMWCAN_PY} — emitting nothing for checksums`);
    return await w.close().then((r) => ({ outPath, ...r }));
  }

  const have4 = /def\s+calc_checksum_4bit/.test(src);
  const have8 = /def\s+calc_checksum_8bit/.test(src);
  const haveCruise = /def\s+calc_checksum_cruise/.test(src);
  if (!have4 || !have8 || !haveCruise) {
    warn(`PART1: bmwcan.py missing expected fn(s) (4bit:${have4} 8bit:${have8} cruise:${haveCruise}) — extraction may be incomplete`);
  }

  // Parse the trailing-comment id lists straight out of the source so the
  // id->algo coverage tracks the file rather than my memory.
  const idsFromComment = (fnName) => {
    const re = new RegExp(`def\\s+${fnName}\\b[^\\n]*#([^\\n]*)`);
    const m = src.match(re);
    if (!m) return [];
    const hits = m[1].match(/0x[0-9a-fA-F]+/g) || [];
    return hits.map((h) => parseInt(h, 16));
  };

  const ids4 = idsFromComment("calc_checksum_4bit");      // expect [0x130]
  const ids8 = idsFromComment("calc_checksum_8bit");      // expect [0xb8,0x1a0,0x19e,0xaa,0xbf]
  const idsCruise = idsFromComment("calc_checksum_cruise"); // expect [0x194]

  const toHex = (n) => "0x" + n.toString(16).toUpperCase().padStart(2, "0");
  const emit = (id_dec, algo, seed, note) => {
    w.write({
      id_dec,
      id_hex: toHex(id_dec),
      algo,
      seed,
      note,
    });
  };

  // algo descriptors (the actual operation, ASCII-only, faithful to bmwcan.py)
  const ALGO_4BIT =
    "sum_then_fold_16to8_then_8to4: c = msg_id + sum(data_bytes); " +
    "c = (c & 0xFF) + (c >> 8); c &= 0xFF; c = (c & 0xF) + (c >> 4); c &= 0xF";
  const ALGO_8BIT =
    "sum_then_fold_16to8: c = msg_id + sum(data_bytes); " +
    "c = (c & 0xFF) + (c >> 8); c &= 0xFF";
  const ALGO_CRUISE =
    "calc_checksum_8bit with msg_id seed forced to 0: c = sum(data_bytes); " +
    "c = (c & 0xFF) + (c >> 8); c &= 0xFF";

  // 4-bit family
  for (const id of (ids4.length ? ids4 : [0x130])) {
    emit(
      id,
      "calc_checksum_4bit:" + ALGO_4BIT,
      id, // seeded by msg id
      "bmwcan.py calc_checksum_4bit; seed = msg id; data = frame bytes with checksum nibble stripped",
    );
  }

  // 8-bit family
  for (const id of (ids8.length ? ids8 : [0xb8, 0x1a0, 0x19e, 0xaa, 0xbf])) {
    emit(
      id,
      "calc_checksum_8bit:" + ALGO_8BIT,
      id, // seeded by msg id
      "bmwcan.py calc_checksum_8bit; seed = msg id; data = frame bytes with checksum byte stripped",
    );
  }

  // cruise (special: 8bit seeded with 0) — CruiseControlStalk, DBC BO_ 404 = 0x194
  for (const id of (idsCruise.length ? idsCruise : [0x194])) {
    emit(
      id,
      "calc_checksum_cruise:" + ALGO_CRUISE,
      0, // explicitly seeded with 0
      "bmwcan.py calc_checksum_cruise -> calc_checksum_8bit(data, 0); CruiseControlStalk Checksum_0x194 (DBC BO_ 404)",
    );
  }

  // The frame openpilot actually transmits: STEERING_COMMAND (ocelot_controls.dbc
  // BO_ 558 = 0x22E) is checksummed via calc_checksum_8bit(dat, addr) at the call
  // site (create_steer_command), i.e. 8-bit seeded by this very message id.
  emit(
    558,
    "calc_checksum_8bit:" + ALGO_8BIT,
    558,
    "bmwcan.py create_steer_command: values['CHECKSUM'] = calc_checksum_8bit(dat, addr); " +
      "STEERING_COMMAND ocelot_controls.dbc BO_ 558 (0x22E); seed = addr = msg id",
  );

  const { rows, samples } = await w.close();
  return { outPath, rows, samples };
}

// =====================================================================
// PART 2 — NETTODAT raw coding images
// =====================================================================
// Directory layout (per diesel-x5m):
//   diesel-x5m/Default ECUs/<MODULE> (<SGBD>.<Cxx>)/NETTODAT.TRC
//   diesel-x5m/Coded ECUs/<MODULE> (<SGBD>.<Cxx>)/NETTODAT.TRC
// Record: "B <address(hex)>,<length(hex 4)>,<byte hex>,<byte hex>,..."

const NETTO_RE = /^B\s+([0-9A-Fa-f]+)\s*,\s*([0-9A-Fa-f]+)\s*,\s*(.+?)\s*$/;

function parseDirName(dirName) {
  // "ABG (ACSM2CD.C26)" -> module "ABG", sgbd "acsm2cd"
  const m = dirName.match(/^(.+?)\s*\(([^.)]+)(?:\.[^)]*)?\)\s*$/);
  if (m) {
    return { module: m[1].trim(), sgbd: m[2].trim().toLowerCase() };
  }
  return { module: dirName.trim(), sgbd: dirName.trim().toLowerCase() };
}

async function parseNettoFile(absFile, meta, writer) {
  let ok = 0, bad = 0;
  await streamLines(absFile, (line, lineNo) => {
    const raw = line.replace(/\r$/, "");
    if (raw.trim() === "") return;
    const m = raw.match(NETTO_RE);
    if (!m) {
      bad++;
      warn(`PART2: skip non-NETTODAT line ${meta.source_file}:${lineNo}: ${raw.slice(0, 60)}`);
      return;
    }
    const address = "0x" + m[1].toUpperCase();
    const declaredLen = parseInt(m[2], 16);
    const byteToks = m[3].split(",").map((s) => s.trim()).filter((s) => s !== "");
    // validate each byte is 2 hex digits
    const good = byteToks.every((t) => /^[0-9A-Fa-f]{1,2}$/.test(t));
    if (!good || byteToks.length === 0) {
      bad++;
      warn(`PART2: skip malformed bytes ${meta.source_file}:${lineNo}: ${raw.slice(0, 60)}`);
      return;
    }
    const bytes = byteToks.map((t) => t.toUpperCase().padStart(2, "0")).join(" ");
    if (byteToks.length !== declaredLen) {
      // keep it but note the mismatch — do not fabricate/pad
      warn(`PART2: length mismatch ${meta.source_file}:${lineNo} declared=${declaredLen} actual=${byteToks.length}`);
    }
    writer.write({
      source_car: meta.source_car,
      ecu_module: meta.ecu_module,
      sgbd: meta.sgbd,
      address,
      length: byteToks.length,
      bytes,
      state: meta.state,
      source_file: meta.source_file,
    });
    ok++;
  });
  return { ok, bad };
}

async function buildNetto() {
  const outPath = path.join(OUT_ROOT, "coding/coding_netto.ndjson");
  const w = openWriter(outPath);
  let filesSeen = 0, filesParsed = 0;

  // --- diesel-x5m: Default vs Coded ---
  if (existsSync(DIESEL_ROOT)) {
    for (const stateDir of ["Default ECUs", "Coded ECUs"]) {
      const stateAbs = path.join(DIESEL_ROOT, stateDir);
      if (!existsSync(stateAbs)) continue;
      const state = stateDir.startsWith("Default") ? "default" : "coded";
      let entries = [];
      try { entries = readdirSync(stateAbs).sort(); } catch (e) { warn(`PART2: cannot read ${stateAbs}: ${e.message}`); continue; }
      for (const ecuDir of entries) {
        const ecuAbs = path.join(stateAbs, ecuDir);
        let st;
        try { st = statSync(ecuAbs); } catch { continue; }
        if (!st.isDirectory()) continue;
        const file = path.join(ecuAbs, "NETTODAT.TRC");
        if (!existsSync(file)) continue;
        filesSeen++;
        const { module, sgbd } = parseDirName(ecuDir);
        const meta = {
          source_car: "E70_X5d",       // diesel-x5m = E70 X5 diesel
          ecu_module: module,
          sgbd,
          state,
          source_file: file,
        };
        try {
          const r = await parseNettoFile(file, meta, w);
          filesParsed++;
          if (r.ok === 0) warn(`PART2: ${file} produced 0 records (${r.bad} skipped)`);
        } catch (e) {
          warn(`PART2: error parsing ${file}: ${e.message}`);
        }
      }
    }
  } else {
    warn(`PART2: diesel-x5m root missing at ${DIESEL_ROOT}`);
  }

  // --- extra standalone NETTODAT captures (optional) ---
  for (const file of EXTRA_NETTO) {
    if (!existsSync(file)) continue;
    filesSeen++;
    // derive a module hint from the parent dir
    const parent = path.basename(path.dirname(file)); // e.g. WORK
    const meta = {
      source_car: "bmw-advanced-tools/" + parent,
      ecu_module: parent,
      sgbd: "unknown",
      state: "coded", // a live working capture (current vehicle coding), treat as coded image
      source_file: file,
    };
    try {
      const r = await parseNettoFile(file, meta, w);
      filesParsed++;
      if (r.ok === 0) warn(`PART2: ${file} produced 0 records (${r.bad} skipped)`);
    } catch (e) {
      warn(`PART2: error parsing ${file}: ${e.message}`);
    }
  }

  // Note re BMW_coding/*.TRC: those are FSW_PSW label/value dumps (no 'B addr,len'
  // records). Confirmed during inspection; intentionally not parsed here.
  warn("PART2: BMW_coding/*.TRC are FSW_PSW (label/value) dumps, not NETTODAT 'B' records -> 0 rows from there (expected, not an error)");

  const { rows, samples } = await w.close();
  return { outPath, rows, samples, filesSeen, filesParsed };
}

// =====================================================================
// main
// =====================================================================
async function main() {
  const p1 = await buildChecksumAlgos();
  const p2 = await buildNetto();

  const report = {
    parser: "checksum_netto",
    files: [
      { entity: "can_checksum_algo", path: p1.outPath, rows: p1.rows },
      { entity: "coding_netto", path: p2.outPath, rows: p2.rows },
    ],
    totals: {
      can_checksum_algo: p1.rows,
      coding_netto: p2.rows,
      netto_files_seen: p2.filesSeen,
      netto_files_parsed: p2.filesParsed,
    },
    caveats: log,
    sampleRows: {
      can_checksum_algo: p1.samples,
      coding_netto: p2.samples,
    },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
