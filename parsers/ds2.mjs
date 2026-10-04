#!/usr/bin/env node
// BMW Unified DB — Layer 4: Legacy DS2 (MS43 / M54, pre-UDS K-line)
//
// Sources (TypeScript static-data modules, reconstructed from SGBD MS430DS0.prg):
//   j2534/examples/ds2/src/ms43-jobs.ts      -> DS2_SERVICE / ACTUATOR_ID / STATUS_GROUP enums,
//                                                MS43 job library (methods + EDIABAS JSDoc names)
//   j2534/examples/ds2/src/job-registry.ts   -> JOB_REGISTRY (display name, description, formatter)
//   j2534/examples/ds2/src/ms43-faults.ts    -> FAULT_LOCATIONS (ORT), FAULT_TYPES (ART),
//                                                FAULT_ENV_CONDITIONS (UMWELT)
//
// Emits NDJSON per SCHEMA.md:
//   build/ds2/ds2_job.ndjson    (ecu, id, name, description, formatter, ...)
//   build/ds2/ds2_fault.ndjson  (ecu, kind in ORT|ART|UMWELT, code, text, ...)
//
// Zero dependencies, Node v22, ESM. Streaming writes. Skip-and-log on malformed input.

import { createWriteStream } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.BMW_REPO_ROOT ? resolve(process.env.BMW_REPO_ROOT) : resolve(__dirname, "..", "..");

const SRC_DIR = resolve(REPO, "j2534/examples/ds2/src");
const JOBS_TS = resolve(SRC_DIR, "ms43-jobs.ts");
const REGISTRY_TS = resolve(SRC_DIR, "job-registry.ts");
const FAULTS_TS = resolve(SRC_DIR, "ms43-faults.ts");

const OUT_DIR = resolve(__dirname, "..", "build", "ds2");
const OUT_JOB = resolve(OUT_DIR, "ds2_job.ndjson");
const OUT_FAULT = resolve(OUT_DIR, "ds2_fault.ndjson");

const ECU = "MS43";
const SGBD = "ms430ds0"; // SGBD MS430DS0.prg -> lowercased filename w/o extension (universal join key)

const caveats = [];
const log = (m) => process.stderr.write(`[ds2] ${m}\n`);

// ── tiny streaming NDJSON writer ──────────────────────────────────
function ndjsonWriter(path) {
  const ws = createWriteStream(path, { encoding: "utf8" });
  let rows = 0;
  return {
    write(obj) {
      rows++;
      const line = JSON.stringify(obj) + "\n";
      if (!ws.write(line)) return once(ws, "drain");
      return null;
    },
    async close() {
      ws.end();
      await once(ws, "finish");
      return rows;
    },
    get rows() {
      return rows;
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────

// Extract the body of a top-level `export const NAME ... = <open> ... <close>` literal.
// `open`/`close` default to braces (object literals); pass "[" / "]" for arrays.
// Returns the text BETWEEN the outermost delimiters (string/comment aware).
function extractBraceBlock(src, declRegex, open = "{", close = "}") {
  const m = declRegex.exec(src);
  if (!m) return null;
  // find the first opening delimiter at/after the match end
  let i = src.indexOf(open, m.index + m[0].length - 1);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inStr = null; // quote char or null
  let prev = "";
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      prev = c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      prev = c;
      continue;
    }
    // skip line comments
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      prev = "\n";
      continue;
    }
    // skip block comments
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      prev = "";
      continue;
    }
    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
    prev = c;
  }
  return null;
}

// Strip /* */ and // comments outside of strings. Returns cleaned text.
function stripComments(text) {
  let out = "";
  let inStr = null;
  let prev = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === inStr && prev !== "\\") inStr = null;
      prev = c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      out += c;
      prev = c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      prev = "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on '/'
      prev = "";
      continue;
    }
    out += c;
    prev = c;
  }
  return out;
}

// Parse a numeric-key -> number enum block: `KEY: 0xNN,`
function parseNumberEnum(block) {
  const out = {};
  if (!block) return out;
  const clean = stripComments(block);
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(0x[0-9a-fA-F]+|\d+)\s*,?/g;
  let m;
  while ((m = re.exec(clean))) {
    out[m[1]] = parseInt(m[2], m[2].startsWith("0x") ? 16 : 10);
  }
  return out;
}

// Parse a `Record<number, string>` block: lines like `0xNN: "text",`
// Strips trailing `// comment`. Handles escaped quotes inside the string.
function parseHexStringRecord(block) {
  const out = [];
  if (!block) return out;
  const re = /(0x[0-9a-fA-F]+|\d+)\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?/g;
  let m;
  while ((m = re.exec(block))) {
    const code = parseInt(m[1], m[1].startsWith("0x") ? 16 : 10);
    const text = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    out.push({ code, text });
  }
  return out;
}

// Parse FAULT_ENV_CONDITIONS: `0xNN: { text: "..", unit: "..", factorA: n, factorB: n },`
function parseEnvConditions(block) {
  const out = [];
  if (!block) return out;
  const re = /(0x[0-9a-fA-F]+|\d+)\s*:\s*\{([^}]*)\}\s*,?/g;
  let m;
  while ((m = re.exec(block))) {
    const code = parseInt(m[1], m[1].startsWith("0x") ? 16 : 10);
    const inner = m[2];
    const text = (/text\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(inner) || [, ""])[1];
    const unit = (/unit\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(inner) || [, ""])[1];
    const fa = (/factorA\s*:\s*(-?[0-9.]+)/.exec(inner) || [, null])[1];
    const fb = (/factorB\s*:\s*(-?[0-9.]+)/.exec(inner) || [, null])[1];
    out.push({
      code,
      text,
      unit,
      factorA: fa === null ? null : Number(fa),
      factorB: fb === null ? null : Number(fb),
    });
  }
  return out;
}

const hex = (n) => "0x" + n.toString(16).padStart(2, "0");

// ── parse ms43-jobs.ts: enums + MS43 method -> {ediabas, firstService, description} ──

function parseJobsModule(src) {
  const DS2_SERVICE = parseNumberEnum(
    extractBraceBlock(src, /export const DS2_SERVICE\s*=\s*/)
  );
  const ACTUATOR_ID = parseNumberEnum(
    extractBraceBlock(src, /export const ACTUATOR_ID\s*=\s*/)
  );
  const STATUS_GROUP = parseNumberEnum(
    extractBraceBlock(src, /export const STATUS_GROUP\s*=\s*/)
  );

  const enums = { DS2_SERVICE, ACTUATOR_ID, STATUS_GROUP };

  // Resolve a token like "DS2_SERVICE.ACTUATOR_CONTROL", "0x22", "0xff", "42"
  const resolveToken = (tok) => {
    tok = tok.trim();
    let mm;
    if ((mm = /^([A-Z_0-9]+)\.([A-Z_0-9]+)$/.exec(tok))) {
      const e = enums[mm[1]];
      if (e && mm[2] in e) return e[mm[2]];
      return null;
    }
    if (/^0x[0-9a-fA-F]+$/.test(tok)) return parseInt(tok, 16);
    if (/^\d+$/.test(tok)) return parseInt(tok, 10);
    return null;
  };

  // Extract the MS43 object block, then split into method entries.
  const ms43Block = extractBraceBlock(src, /export const MS43\s*=\s*/);
  const methods = {}; // methodName -> { ediabas, firstServiceToken, description }

  if (ms43Block) {
    // Find each method declaration `methodName: (args) => ...`
    const methodRe = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g;
    const matches = [];
    let m;
    while ((m = methodRe.exec(ms43Block))) {
      matches.push({ name: m[1], at: m.index, declEnd: methodRe.lastIndex });
    }
    for (let k = 0; k < matches.length; k++) {
      const cur = matches[k];
      const next = matches[k + 1];
      // body = text from this decl end to next decl start (token sniffing)
      const body = ms43Block.slice(cur.declEnd, next ? next.at : ms43Block.length);
      // preceding text from previous decl end (or 0) up to this decl start.
      const prevEnd = k > 0 ? matches[k - 1].declEnd : 0;
      const rawLead = ms43Block.slice(prevEnd, cur.at);
      // Isolate the JSDoc block immediately preceding this method (the LAST
      // /** ... */ in rawLead). Avoids picking up the previous method's code body.
      let lead = "";
      const jsdocMatches = rawLead.match(/\/\*\*[\s\S]*?\*\//g);
      if (jsdocMatches && jsdocMatches.length) lead = jsdocMatches[jsdocMatches.length - 1];

      // EDIABAS job name: token may contain letters, digits, _, * (wildcard) and
      // an optional (...) suffix, e.g. STEUERN_LS_HEIZUNG_*, SEED_KEY (step 1).
      const ediabas = (/EDIABAS:\s*([A-Za-z0-9_*]+(?:\s*\([^)]*\))?)/.exec(lead) || [, null])[1];
      // Description: first non-empty JSDoc line that isn't a tag or the EDIABAS ref.
      let description = null;
      const jsLines = lead
        .split("\n")
        .map((l) => l.replace(/^\s*\/?\*+\/?/, "").replace(/\*\/\s*$/, "").trim())
        .filter((l) => l && !l.startsWith("@") && !/^EDIABAS:/.test(l) && l !== "/" && !/^─+$/.test(l));
      if (jsLines.length) {
        description = jsLines[0].replace(/\s*EDIABAS:.*$/, "").trim() || null;
      }

      // First service token from the first ds2Build([ FIRST , ... ]) call.
      let firstService = null;
      let firstServiceName = null;
      let bm;
      if ((bm = /ds2Build\(\s*\[\s*([^,\]]+)/.exec(body))) {
        firstServiceName = bm[1].trim();
        firstService = resolveToken(bm[1]);
      }
      methods[cur.name] = {
        ediabas: ediabas ? ediabas.trim() : null,
        description,
        firstService,
        firstServiceName,
        body,
      };
    }
  } else {
    caveats.push("Could not locate MS43 object block in ms43-jobs.ts");
  }

  return { enums, methods, resolveToken };
}

// ── parse job-registry.ts: JOB_REGISTRY entries ───────────────────
function parseRegistry(src) {
  const block = extractBraceBlock(
    src,
    /export const JOB_REGISTRY\s*:\s*JobEntry\[\]\s*=\s*/,
    "[",
    "]"
  );
  const entries = [];
  if (!block) {
    caveats.push("Could not locate JOB_REGISTRY array in job-registry.ts");
    return entries;
  }
  // Split into top-level `{ ... }` objects within the array.
  let depth = 0;
  let inStr = null;
  let prev = "";
  let start = -1;
  const objs = [];
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        objs.push(block.slice(start, i + 1));
        start = -1;
      }
    }
    prev = c;
  }
  for (const o of objs) {
    const id = (/\bid\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(o) || [, null])[1];
    const name = (/\bname\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(o) || [, null])[1];
    const category = (/\bcategory\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(o) || [, null])[1];
    const description = (/\bdescription\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(o) || [, null])[1];
    const formatter = (/\bformat\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(o) || [, null])[1];
    // build body, to discover which MS43 method this job invokes
    const buildMethod =
      (/\bbuild\s*:\s*(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>\s*[^]*?MS43\.([A-Za-z0-9_]+)\s*\(/.exec(o) ||
        [, null])[1];
    if (!id) continue; // skip malformed entry
    entries.push({ id, name, category, description, formatter, buildMethod });
  }
  return entries;
}

// ── main ──────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // ---- read sources ----
  let jobsSrc, registrySrc, faultsSrc;
  try {
    jobsSrc = await readFile(JOBS_TS, "utf8");
  } catch (e) {
    caveats.push(`Cannot read ${JOBS_TS}: ${e.message}`);
  }
  try {
    registrySrc = await readFile(REGISTRY_TS, "utf8");
  } catch (e) {
    caveats.push(`Cannot read ${REGISTRY_TS}: ${e.message}`);
  }
  try {
    faultsSrc = await readFile(FAULTS_TS, "utf8");
  } catch (e) {
    caveats.push(`Cannot read ${FAULTS_TS}: ${e.message}`);
  }

  // ======================= ds2_job =======================
  const jobWriter = ndjsonWriter(OUT_JOB);

  let methods = {},
    enums = { DS2_SERVICE: {}, ACTUATOR_ID: {}, STATUS_GROUP: {} };
  if (jobsSrc) {
    try {
      const parsed = parseJobsModule(jobsSrc);
      methods = parsed.methods;
      enums = parsed.enums;
      log(
        `parsed enums: DS2_SERVICE=${Object.keys(enums.DS2_SERVICE).length}, ` +
          `ACTUATOR_ID=${Object.keys(enums.ACTUATOR_ID).length}, ` +
          `STATUS_GROUP=${Object.keys(enums.STATUS_GROUP).length}; ` +
          `MS43 methods=${Object.keys(methods).length}`
      );
    } catch (e) {
      caveats.push(`Failed to parse ms43-jobs.ts: ${e.message}`);
    }
  }

  const registry = registrySrc ? parseRegistry(registrySrc) : [];
  log(`parsed JOB_REGISTRY entries=${registry.length}`);

  const seenJobIds = new Set();
  let jobRows = 0;

  // Primary job source: JOB_REGISTRY (has display name, description, formatter).
  for (const e of registry) {
    try {
      const meth = e.buildMethod ? methods[e.buildMethod] : null;
      const svc = meth && meth.firstService != null ? meth.firstService : null;
      const ediabas = meth ? meth.ediabas : null;
      const row = {
        ecu: ECU,
        sgbd: SGBD,
        id: svc != null ? hex(svc) : null, // hex DS2 service byte (on-wire command id)
        name: e.name,
        description: e.description,
        formatter: e.formatter,
        job_id: e.id, // registry string id (e.g. "fuel_pump")
        category: e.category,
        ediabas_job: ediabas, // EDIABAS SGBD job name (e.g. STEUERN_EKP)
        build_method: e.buildMethod, // MS43.<method>
        source_table: "JOB_REGISTRY",
      };
      const w = jobWriter.write(row);
      if (w) await w;
      jobRows++;
      if (e.buildMethod) seenJobIds.add(e.buildMethod);
    } catch (err) {
      caveats.push(`skip registry job ${e.id || "?"}: ${err.message}`);
    }
  }

  // Secondary: MS43 methods carrying an EDIABAS job name not surfaced in the
  // registry (so the SGBD job inventory is complete).
  for (const [mname, meth] of Object.entries(methods)) {
    if (!meth.ediabas) continue;
    if (seenJobIds.has(mname)) continue;
    try {
      const svc = meth.firstService != null ? meth.firstService : null;
      const row = {
        ecu: ECU,
        sgbd: SGBD,
        id: svc != null ? hex(svc) : null,
        name: meth.ediabas, // EDIABAS job name as display name
        description: meth.description,
        formatter: null,
        job_id: mname,
        category: null,
        ediabas_job: meth.ediabas,
        build_method: mname,
        source_table: "MS43",
      };
      const w = jobWriter.write(row);
      if (w) await w;
      jobRows++;
    } catch (err) {
      caveats.push(`skip MS43 method ${mname}: ${err.message}`);
    }
  }

  const jobCount = await jobWriter.close();

  // ======================= ds2_fault =======================
  const faultWriter = ndjsonWriter(OUT_FAULT);
  let ortRows = 0,
    artRows = 0,
    umweltRows = 0;

  if (faultsSrc) {
    // ORT — FAULT_LOCATIONS (Record<number,string>)
    try {
      const block = extractBraceBlock(
        faultsSrc,
        /export const FAULT_LOCATIONS\s*:\s*Record<number,\s*string>\s*=\s*/
      );
      const recs = parseHexStringRecord(block);
      for (const r of recs) {
        const w = faultWriter.write({
          ecu: ECU,
          sgbd: SGBD,
          kind: "ORT",
          code: hex(r.code),
          code_dec: r.code,
          text: r.text,
          source_table: "FORTTEXTE",
        });
        if (w) await w;
        ortRows++;
      }
    } catch (e) {
      caveats.push(`Failed to parse FAULT_LOCATIONS: ${e.message}`);
    }

    // ART — FAULT_TYPES (Record<number,string>)
    try {
      const block = extractBraceBlock(
        faultsSrc,
        /export const FAULT_TYPES\s*:\s*Record<number,\s*string>\s*=\s*/
      );
      const recs = parseHexStringRecord(block);
      for (const r of recs) {
        const w = faultWriter.write({
          ecu: ECU,
          sgbd: SGBD,
          kind: "ART",
          code: hex(r.code),
          code_dec: r.code,
          text: r.text,
          source_table: "FARTTEXTE",
        });
        if (w) await w;
        artRows++;
      }
    } catch (e) {
      caveats.push(`Failed to parse FAULT_TYPES: ${e.message}`);
    }

    // UMWELT — FAULT_ENV_CONDITIONS (Record<number,{text,unit,factorA,factorB}>)
    try {
      const block = extractBraceBlock(
        faultsSrc,
        /export const FAULT_ENV_CONDITIONS\s*:\s*Record<number,\s*\{[^}]*\}>\s*=\s*/
      );
      const recs = parseEnvConditions(block);
      for (const r of recs) {
        const w = faultWriter.write({
          ecu: ECU,
          sgbd: SGBD,
          kind: "UMWELT",
          code: hex(r.code),
          code_dec: r.code,
          text: r.text,
          unit: r.unit,
          factor_a: r.factorA,
          factor_b: r.factorB,
          source_table: "FUMWELTTEXTE",
        });
        if (w) await w;
        umweltRows++;
      }
    } catch (e) {
      caveats.push(`Failed to parse FAULT_ENV_CONDITIONS: ${e.message}`);
    }
  }

  const faultCount = await faultWriter.close();

  // ---- sanity checks vs declared dimensions in source comments ----
  if (ortRows && ortRows < 100) caveats.push(`ORT rows unexpectedly low: ${ortRows}`);
  if (artRows && artRows < 100) caveats.push(`ART rows unexpectedly low: ${artRows}`);
  caveats.push(
    `Fault table actuals: ORT=${ortRows} (header claims ~170), ` +
      `ART=${artRows} (header claims ~144), UMWELT=${umweltRows}.`
  );
  if (jobCount === 0) caveats.push("No ds2_job rows produced");
  if (faultCount === 0) caveats.push("No ds2_fault rows produced");

  return {
    jobRows,
    jobCount,
    faultCount,
    ortRows,
    artRows,
    umweltRows,
    enumCounts: {
      DS2_SERVICE: Object.keys(enums.DS2_SERVICE).length,
      ACTUATOR_ID: Object.keys(enums.ACTUATOR_ID).length,
      STATUS_GROUP: Object.keys(enums.STATUS_GROUP).length,
    },
  };
}

main()
  .then((stats) => {
    log(
      `DONE jobs=${stats.jobCount} faults=${stats.faultCount} ` +
        `(ORT=${stats.ortRows} ART=${stats.artRows} UMWELT=${stats.umweltRows})`
    );
    log(`outputs: ${OUT_JOB} , ${OUT_FAULT}`);
    if (caveats.length) log(`caveats:\n  - ${caveats.join("\n  - ")}`);
  })
  .catch((e) => {
    log(`FATAL: ${e.stack || e.message}`);
    process.exitCode = 1;
  });
