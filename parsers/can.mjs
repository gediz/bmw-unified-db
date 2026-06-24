#!/usr/bin/env node
// Layer 5 - Live CAN bus parser (zero-dependency, Node v22 ESM).
//
// Primary structured source: a standard Vector DBC
//   opendbc/opendbc/dbc/bmw_e9x_e8x.dbc
// Secondary best-effort enrichment (comments / extra rows): the openpilot BMW port
//   openpilot/selfdrive/car/bmw/{values.py,bmwcan.py,carstate.py,fingerprints.py}
//
// Emits (per SCHEMA.md, chassis = "E8x_E9x"):
//   build/can/can_message.ndjson  (chassis,id_dec)
//   build/can/can_signal.ndjson   (message_id_dec,name)
//   build/can/can_value.ndjson    (message_id_dec,signal,value)
//
// Robustness: parse line-by-line, skip-and-log malformed records, never crash the run.
// Streaming: read the DBC line-by-line, append each NDJSON record as it is produced.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", ".."); // .../bmw
const OUT_DIR = resolve(__dirname, "..", "build", "can"); // bmw-unified-db/build/can

const DBC_PATH = resolve(REPO_ROOT, "opendbc/opendbc/dbc/bmw_e9x_e8x.dbc");
const PY_DIR = resolve(REPO_ROOT, "openpilot/selfdrive/car/bmw");

const CHASSIS = "E8x_E9x";

// ---------------------------------------------------------------------------
// small NDJSON sink helper
// ---------------------------------------------------------------------------
class NdjsonSink {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.stream = createWriteStream(path, { encoding: "utf8" });
    this.count = 0;
  }
  write(obj) {
    this.stream.write(JSON.stringify(obj) + "\n");
    this.count++;
  }
  close() {
    return new Promise((res) => this.stream.end(res));
  }
}

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  process.stderr.write("WARN: " + msg + "\n");
}

// ---------------------------------------------------------------------------
// Secondary source mining (openpilot python) - best-effort, regex based.
// Produces:
//   busOfMsg:    Map<id_dec, "PT-CAN"|"F-CAN"|"STEPPER_SERVO_CAN">  (from fingerprints.py)
//   checksumIds: Set<id_dec>  (from bmwcan.py checksum comments)
//   extraNotes:  Map<id_dec, string[]>  free-form notes appended to message comment
//   stepperRows: array of synthetic message rows (StepperServoCAN, ocelot_controls)
// ---------------------------------------------------------------------------
function minePython() {
  const busOfMsg = new Map();
  const checksumIds = new Set();
  const extraNotes = new Map();
  const stepperRows = [];
  const note = (id, s) => {
    if (!extraNotes.has(id)) extraNotes.set(id, []);
    extraNotes.get(id).push(s);
  };

  // --- fingerprints.py: per-bus address->length maps ---
  try {
    const fp = readFileSync(resolve(PY_DIR, "fingerprints.py"), "utf8");
    // grab the "<BUS>": { ... } blocks inside BMW_E8x_E9x_common_per_bus
    const busBlockRe = /"([A-Z_-]+)"\s*:\s*\{([^}]*)\}/g;
    let m;
    while ((m = busBlockRe.exec(fp)) !== null) {
      const busName = m[1];
      const body = m[2];
      const pairRe = /(\d+)\s*:\s*\d+/g;
      let p;
      while ((p = pairRe.exec(body)) !== null) {
        const id = parseInt(p[1], 10);
        // first bus listed wins (PT-CAN before F-CAN before STEPPER_SERVO_CAN)
        if (!busOfMsg.has(id)) busOfMsg.set(id, busName);
      }
    }
  } catch (e) {
    warn(`fingerprints.py mine failed: ${e.message}`);
  }

  // --- bmwcan.py: checksum-relevant message ids from comments ---
  try {
    const bc = readFileSync(resolve(PY_DIR, "bmwcan.py"), "utf8");
    // lines like:  def calc_checksum_4bit(...): # 0x130
    //              def calc_checksum_8bit(...): # 0xb8 0x1a0 0x19e 0xaa 0xbf
    for (const line of bc.split(/\r?\n/)) {
      const cm = line.match(/calc_checksum[_a-z0-9]*\([^)]*\):\s*#\s*(.+)$/);
      if (cm) {
        const hexes = cm[1].match(/0x[0-9a-fA-F]+/g) || [];
        const kind = line.includes("4bit") ? "4-bit" : line.includes("cruise") ? "cruise" : "8-bit";
        for (const h of hexes) {
          const id = parseInt(h, 16);
          checksumIds.add(id);
          note(id, `checksum:${kind} (StepperServoCAN)`);
        }
      }
      // cruise checksum special case noted inline (0x194)
      const cc = line.match(/calc_checksum_cruise.*#\s*(0x[0-9a-fA-F]+)/);
      if (cc) {
        const id = parseInt(cc[1], 16);
        checksumIds.add(id);
        note(id, "checksum:cruise init0 (StepperServoCAN)");
      }
    }
  } catch (e) {
    warn(`bmwcan.py mine failed: ${e.message}`);
  }

  // --- values.py: CanBus map + StepperServoCAN actuator message id ---
  let canBusMap = {};
  try {
    const vp = readFileSync(resolve(PY_DIR, "values.py"), "utf8");
    const busRe = /^\s*([A-Z_]+)\s*=\s*(\d+)\b/gm;
    // only within the `class CanBus:` block
    const clsIdx = vp.indexOf("class CanBus:");
    if (clsIdx >= 0) {
      const nextCls = vp.indexOf("\nclass ", clsIdx + 1);
      const after = vp.slice(clsIdx, nextCls === -1 ? undefined : nextCls);
      let bm;
      while ((bm = busRe.exec(after)) !== null) {
        canBusMap[bm[1]] = parseInt(bm[2], 10);
      }
    }
  } catch (e) {
    warn(`values.py mine failed: ${e.message}`);
  }

  // --- StepperServoCAN messages (from fingerprints STEPPER_SERVO_CAN + bmwcan/carstate) ---
  // id 559 (0x22F) carries STEERING_COMMAND (tx by actuator) and STEERING_STATUS (rx).
  // Defined in the 'ocelot_controls' DBC (not present in this repo); we capture it as
  // synthetic enrichment rows so downstream consumers know it exists on SERVO_CAN.
  const servoId = 559;
  stepperRows.push({
    chassis: CHASSIS,
    id_dec: servoId,
    id_hex: "0x" + servoId.toString(16).toUpperCase(),
    name: "STEERING_COMMAND",
    length: 8,
    tx_node: "StepperServoCAN",
    comment:
      "StepperServoCAN actuator command (dbc 'ocelot_controls', bus SERVO_CAN=1). " +
      "Signals: COUNTER, STEER_MODE{Off=0,TorqueControl=1,AngleControl=2,SoftOff=3}, " +
      "STEER_ANGLE, STEER_TORQUE, CHECKSUM(8bit). Source: openpilot bmwcan.py/carstate.py",
    bus: "STEPPER_SERVO_CAN",
    source: "openpilot",
  });
  stepperRows.push({
    chassis: CHASSIS,
    id_dec: servoId,
    id_hex: "0x" + servoId.toString(16).toUpperCase(),
    name: "STEERING_STATUS",
    length: 8,
    tx_node: "StepperServoCAN",
    comment:
      "StepperServoCAN actuator status (dbc 'ocelot_controls', bus SERVO_CAN=1). " +
      "Signals read by openpilot: STEERING_TORQUE, STEERING_ANGLE, CONTROL_STATUS(&0x4=fault). " +
      "Source: openpilot carstate.py",
    bus: "STEPPER_SERVO_CAN",
    source: "openpilot",
  });

  return { busOfMsg, checksumIds, extraNotes, stepperRows, canBusMap };
}

// ---------------------------------------------------------------------------
// DBC parsers
// ---------------------------------------------------------------------------

// BO_ <id> <name>: <len> <tx>
function parseBO(line) {
  const m = line.match(/^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s+(\S+)\s*$/);
  if (!m) return null;
  return {
    id_dec: parseInt(m[1], 10),
    name: m[2],
    length: parseInt(m[3], 10),
    tx_node: m[4],
  };
}

// SG_ <name> [M|m<n>] : <start>|<len>@<order><sign> (<factor>,<offset>) [<min>|<max>] "<unit>" <receivers>
function parseSG(line) {
  // tolerate optional multiplexer token between name and ':'
  const m = line.match(
    /^\s*SG_\s+([A-Za-z0-9_]+)\s*(?:[Mm]\d*\s+)?:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*)$/
  );
  if (!m) return null;
  const receivers = m[11]
    .trim()
    .split(/[\s,]+/)
    .filter((r) => r.length > 0);
  return {
    name: m[1],
    start_bit: parseInt(m[2], 10),
    length: parseInt(m[3], 10),
    // @1 = little-endian (Intel), @0 = big-endian (Motorola)
    byte_order: m[4] === "1" ? "little_endian" : "big_endian",
    is_signed: m[5] === "-" ? 1 : 0,
    factor: numOrNull(m[6]),
    offset: numOrNull(m[7]),
    min: numOrNull(m[8]),
    max: numOrNull(m[9]),
    unit: m[10],
    receivers,
  };
}

function numOrNull(s) {
  const t = (s || "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// VAL_ <id> <signal> <val> "<label>" <val> "<label>" ... ;
function parseVAL(line) {
  const m = line.match(/^VAL_\s+(\d+)\s+([A-Za-z0-9_]+)\s+(.*);?\s*$/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  const signal = m[2];
  let rest = m[3].replace(/;\s*$/, "");
  const pairs = [];
  const pairRe = /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g;
  let p;
  while ((p = pairRe.exec(rest)) !== null) {
    pairs.push({ value: parseInt(p[1], 10), label: p[2].replace(/\\"/g, '"') });
  }
  if (pairs.length === 0) return null;
  return { id, signal, pairs };
}

// CM_ comments:
//   CM_ "global";                          -> global (ignored for rows)
//   CM_ BO_ <id> "text";                   -> message comment
//   CM_ SG_ <id> <signal> "text";          -> signal comment
//   CM_ BU_ <node> "text";                 -> node comment (ignored)
function parseCM(line) {
  let m = line.match(/^CM_\s+SG_\s+(\d+)\s+([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*;?\s*$/);
  if (m) return { kind: "SG", id: parseInt(m[1], 10), signal: m[2], text: m[3] };
  m = line.match(/^CM_\s+BO_\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*;?\s*$/);
  if (m) return { kind: "BO", id: parseInt(m[1], 10), text: m[2] };
  return null;
}

// ---------------------------------------------------------------------------
// Pass over the DBC once (line streaming) and collect into in-memory
// structures keyed by message id. The file is ~32KB so this is safe; we still
// stream the read so we never block on a giant buffer.
// ---------------------------------------------------------------------------
async function parseDbc(path) {
  const messages = new Map(); // id -> {meta, signals:[]}
  const valuesByMsg = new Map(); // id -> [{signal,value,label}]
  const sgComments = new Map(); // `${id}|${signal}` -> text
  const boComments = new Map(); // id -> text

  let currentMsgId = null;
  let lineNo = 0;

  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    lineNo++;
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    try {
      if (line.startsWith("BO_ ")) {
        const bo = parseBO(line);
        if (!bo) {
          warn(`line ${lineNo}: malformed BO_: ${line.slice(0, 80)}`);
          currentMsgId = null;
          continue;
        }
        currentMsgId = bo.id_dec;
        if (messages.has(bo.id_dec)) {
          warn(`duplicate BO_ id ${bo.id_dec} (${bo.name}); keeping first`);
        } else {
          messages.set(bo.id_dec, { ...bo, signals: [] });
        }
      } else if (/^\s*SG_\s/.test(line)) {
        const sg = parseSG(line);
        if (!sg) {
          warn(`line ${lineNo}: malformed SG_: ${line.slice(0, 80)}`);
          continue;
        }
        if (currentMsgId === null) {
          warn(`line ${lineNo}: SG_ with no enclosing BO_: ${sg.name}`);
          continue;
        }
        const msg = messages.get(currentMsgId);
        if (msg) msg.signals.push(sg);
      } else if (line.startsWith("VAL_ ")) {
        const v = parseVAL(line);
        if (!v) {
          warn(`line ${lineNo}: malformed VAL_: ${line.slice(0, 80)}`);
          continue;
        }
        if (!valuesByMsg.has(v.id)) valuesByMsg.set(v.id, []);
        const arr = valuesByMsg.get(v.id);
        for (const pr of v.pairs) arr.push({ signal: v.signal, value: pr.value, label: pr.label });
      } else if (line.startsWith("CM_")) {
        // comments are single-line in this DBC
        const cm = parseCM(line);
        if (cm) {
          if (cm.kind === "SG") sgComments.set(`${cm.id}|${cm.signal}`, cm.text);
          else if (cm.kind === "BO") boComments.set(cm.id, cm.text);
        }
        // unrecognized CM_ (global / BU_) intentionally ignored
        currentMsgId = null; // CM_ block ends the BO_ scope
      } else {
        // VERSION/NS_/BS_/BU_/BA_ etc - header/metadata; these end any BO_ scope
        if (line.startsWith("BU_") || line.startsWith("BA_") || line.startsWith("VERSION")) {
          currentMsgId = null;
        }
      }
    } catch (e) {
      warn(`line ${lineNo}: parse error (${e.message}): ${line.slice(0, 80)}`);
    }
  }

  return { messages, valuesByMsg, sgComments, boComments };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(DBC_PATH)) {
    warn(`DBC not found at ${DBC_PATH} - aborting`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const py = minePython();
  const { messages, valuesByMsg, sgComments, boComments } = await parseDbc(DBC_PATH);

  const msgSink = new NdjsonSink(resolve(OUT_DIR, "can_message.ndjson"));
  const sigSink = new NdjsonSink(resolve(OUT_DIR, "can_signal.ndjson"));
  const valSink = new NdjsonSink(resolve(OUT_DIR, "can_value.ndjson"));

  // helper: bus inference. DBC has no bus column; enrich from python fingerprints.
  const busFor = (id) => py.busOfMsg.get(id) || null;

  // Emit messages (sorted by id for stable, sane output).
  const ids = [...messages.keys()].sort((a, b) => a - b);
  let signalRows = 0;
  let valueRows = 0;

  for (const id of ids) {
    const msg = messages.get(id);
    // assemble comment: DBC BO_ comment + mined notes
    const parts = [];
    const boc = boComments.get(id);
    if (boc) parts.push(boc);
    const notes = py.extraNotes.get(id);
    if (notes && notes.length) parts.push(notes.join("; "));
    const comment = parts.join(" | ") || null;

    msgSink.write({
      chassis: CHASSIS,
      id_dec: id,
      id_hex: "0x" + id.toString(16).toUpperCase(),
      name: msg.name,
      length: msg.length,
      tx_node: msg.tx_node,
      comment,
      bus: busFor(id),
      is_checksum_protected: py.checksumIds.has(id) ? 1 : 0,
      source: "dbc",
    });

    // signals for this message
    for (const sg of msg.signals) {
      const sc = sgComments.get(`${id}|${sg.name}`) || null;
      sigSink.write({
        message_id_dec: id,
        name: sg.name,
        start_bit: sg.start_bit,
        length: sg.length,
        byte_order: sg.byte_order,
        is_signed: sg.is_signed,
        factor: sg.factor,
        offset: sg.offset,
        min: sg.min,
        max: sg.max,
        unit: sg.unit,
        receivers: sg.receivers,
        comment: sc,
      });
      signalRows++;
    }

    // value tables for this message
    const vals = valuesByMsg.get(id);
    if (vals) {
      for (const v of vals) {
        valSink.write({
          message_id_dec: id,
          signal: v.signal,
          value: v.value,
          label: v.label,
        });
        valueRows++;
      }
    }
  }

  // Data-integrity checks: VAL_/CM_ referencing unknown messages.
  for (const id of valuesByMsg.keys()) {
    if (!messages.has(id)) warn(`VAL_ references unknown message id ${id}`);
  }
  for (const id of boComments.keys()) {
    if (!messages.has(id)) warn(`CM_ BO_ references unknown message id ${id}`);
  }
  for (const key of sgComments.keys()) {
    const sid = parseInt(key.split("|")[0], 10);
    if (!messages.has(sid)) warn(`CM_ SG_ references unknown message id ${sid}`);
  }

  // Emit StepperServoCAN synthetic enrichment messages (from openpilot, not DBC).
  for (const r of py.stepperRows) {
    msgSink.write({ ...r, is_checksum_protected: 1 });
  }

  await Promise.all([msgSink.close(), sigSink.close(), valSink.close()]);

  // ----- validate -----
  const report = {
    files: [
      { entity: "can_message", path: msgSink.path, rows: msgSink.count },
      { entity: "can_signal", path: sigSink.path, rows: sigSink.count },
      { entity: "can_value", path: valSink.path, rows: valSink.count },
    ],
    dbc_messages: messages.size,
    dbc_signal_rows: signalRows,
    dbc_value_rows: valueRows,
    stepper_rows: py.stepperRows.length,
    bus_mapped: py.busOfMsg.size,
    checksum_ids: [...py.checksumIds].sort((a, b) => a - b),
    warnings: warnings.length,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write("FATAL: " + (e && e.stack ? e.stack : String(e)) + "\n");
  process.exitCode = 1;
});
