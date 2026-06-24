#!/usr/bin/env node
// BMW Unified DB — External Layer: FDL-F (F-series E-Sys FDL coding cheats)
// Zero-dependency Node ESM (Node v22). Emits streaming NDJSON:
//   build/external/fdl_code.ndjson
//     { chassis_family, ecu_or_cafd, ecu, cafd, fsw_label, value_label,
//       value_hex, meaning, group, byte_start, byte_end, mask, raw_value, source }
//
// SOURCE (fetched):
//   github.com/packetpilot/bmw-f  ->  cheats/FDLCodes.xml   (GPL-3.0)
//   Raw: https://raw.githubusercontent.com/packetpilot/bmw-f/master/cheats/FDLCodes.xml
//
// The FDLCodes.xml file is an E-Sys "FDL coding cheat" catalog for BMW F-chassis.
// Structure:
//   <FDL>
//     <cafd id="00000794" name="FEM_BODY" series="F020,F030">
//       <code description="Human readable function / value">
//         <group id="3062">
//           <function start="68" end="68" mask="11111111b" comment="...">32</function>
//           ...
//         </group>
//         ...
//       </code>
//       ...
//     </cafd>
//     ...
//   </FDL>
//
// Mapping to the target schema:
//   chassis_family  -> "F"  (whole repo is F-series; chassis tokens uppercase per join convention)
//   ecu_or_cafd     -> "<ECU_NAME>:<CAFD_ID>"  (e.g. "FEM_BODY:0x00000794")
//   ecu             -> the cafd @name (ECU short name, e.g. FEM_BODY / IHKA / KOMBI / NBT)
//   cafd            -> the cafd @id, 0x-prefixed (the canonical CAFD container id)
//   fsw_label       -> the coding-group locus "<group>/<start>" (e.g. "3062/68") — the FDL analog
//                      of an FSW (which byte, in which group, this function writes). The 'mask'
//                      column carries the exact bit-field.
//   value_label     -> symbolic value token when the write value is a named enum (e.g. "Aktiv",
//                      "Soft_On", "TFL_S", "popup_and_config"); null when the value is a raw hex byte.
//   value_hex       -> 0x-prefixed hex of the write value when it is a numeric byte (hex 0x-prefixed
//                      per join convention); null when the value is a symbolic enum token.
//   meaning         -> the parent <code @description> (the human-readable effect of the coding).
//   source          -> provenance string incl. repo, file, license.
//
// One row is emitted per <function> write (the atomic coding write), so join granularity stays at
// the byte/bit-write level used elsewhere in the DB. A single <code> with N function writes yields
// N rows sharing the same `meaning`.
//
// Zero deps: a tiny tag-stream XML scanner (the file is a flat, attribute-driven dialect with no
// CDATA/namespaces), not a generic XML parser.

import { createWriteStream, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');                 // bmw-unified-db
const OUT_DIR = join(ROOT, 'build', 'external');
const OUT_FILE = join(OUT_DIR, 'fdl_code.ndjson');

// Local cache of the fetched raw file (populated by the harness before running, or pass --xml=PATH).
const DEFAULT_XML = '/tmp/FDLCodes.xml';
const SRC_URL = 'https://raw.githubusercontent.com/packetpilot/bmw-f/master/cheats/FDLCodes.xml';
const SRC_REPO = 'github.com/packetpilot/bmw-f';
const LICENSE = 'GPL-3.0';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function argVal(name) {
  const pfx = '--' + name + '=';
  const a = process.argv.find(x => x.startsWith(pfx));
  return a ? a.slice(pfx.length) : null;
}

// ----------------------------------------------------------------------------
// Minimal HTML/XML entity decode (this dialect only uses the basic five + numeric)
// ----------------------------------------------------------------------------
function decodeEntities(s) {
  if (s == null) return s;
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so we don't double-decode
}

// Parse the attributes of a start tag body (already stripped of the tag name).
function parseAttrs(body) {
  const attrs = {};
  for (const m of body.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

// ----------------------------------------------------------------------------
// Tag-stream tokenizer.
// Strips XML comments first (the file ships a commented-out <!-- Sample Only ... -->
// block that MUST be excluded). Then walks tags, tracking cafd/code/group context
// and emitting one record per <function> element with its text content as the value.
// ----------------------------------------------------------------------------
function* tokens(xml) {
  // remove comments (no nested comments in XML)
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  for (const m of xml.matchAll(tagRe)) {
    const text = xml.slice(last, m.index);
    if (text.trim() !== '') yield { type: 'text', value: text };
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2];
    const selfClose = m[4] === '/';
    if (closing) {
      yield { type: 'close', name };
    } else {
      yield { type: 'open', name, attrs: parseAttrs(m[3]), selfClose };
      if (selfClose) yield { type: 'close', name };
    }
  }
}

// Is the value text a pure hex byte literal (E-Sys cheats use bare hex like "01","32","FF","0B")?
const HEX_RE = /^[0-9A-Fa-f]{1,2}$/;
function valueParts(raw) {
  const v = (raw == null ? '' : String(raw)).trim();
  if (v === '') return { value_label: null, value_hex: null };
  if (HEX_RE.test(v)) {
    const n = parseInt(v, 16);
    return { value_label: null, value_hex: '0x' + n.toString(16).toUpperCase().padStart(2, '0') };
  }
  // symbolic enum token (e.g. Aktiv, Soft_On, TFL_S, popup_and_config, perm_on)
  return { value_label: v, value_hex: null };
}

function cafdId(id) {
  if (!id) return null;
  const clean = String(id).trim().replace(/^0x/i, '');
  return '0x' + clean.toUpperCase();
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const xmlPath = argVal('xml') || DEFAULT_XML;

  let xml;
  try {
    xml = readFileSync(xmlPath, 'utf8');
  } catch (e) {
    log('FATAL: could not read FDLCodes.xml at ' + xmlPath + ' : ' + e.message);
    log('The parser needs the raw file fetched from ' + SRC_URL);
    process.exit(2);
  }
  // strip UTF-8 BOM if present
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1);

  const out = createWriteStream(OUT_FILE);

  const source = `${SRC_REPO}/cheats/FDLCodes.xml (${LICENSE})`;

  // context
  let cafd = null;     // { id, name, series }
  let code = null;     // { description }
  let group = null;    // { id }
  let curFn = null;    // { attrs, text }

  let rows = 0;
  const ecuSet = new Set();
  const cafdSet = new Set();
  const labelSet = new Set();       // distinct fsw_label (group/start loci)
  const meaningSet = new Set();     // distinct code descriptions
  const seriesSet = new Set();
  const valLabelSet = new Set();
  let symbolicVals = 0, hexVals = 0, emptyVals = 0;
  const caveats = [];

  function emitFunction() {
    if (!curFn) return;
    const a = curFn.attrs || {};
    const rawValue = decodeEntities((curFn.text || '').trim());
    const { value_label, value_hex } = valueParts(rawValue);
    if (value_label) { symbolicVals++; valLabelSet.add(value_label); }
    else if (value_hex) hexVals++;
    else emptyVals++;

    const ecu = cafd ? cafd.name : null;
    const cafdHex = cafd ? cafdId(cafd.id) : null;
    const ecu_or_cafd = (ecu || cafdHex) ? `${ecu || '?'}:${cafdHex || '?'}` : null;
    const groupId = group ? group.id : null;
    const start = a.start != null ? a.start : null;
    const end = a.end != null ? a.end : null;
    // fsw_label: the FDL locus = coding group + start byte (the "which function" address)
    const fsw_label = (groupId != null && start != null)
      ? `${groupId}/${start}`
      : (groupId != null ? `${groupId}` : null);
    const meaning = code ? code.description : null;

    if (ecu) ecuSet.add(ecu);
    if (cafdHex) cafdSet.add(cafdHex);
    if (fsw_label) labelSet.add(fsw_label);
    if (meaning) meaningSet.add(meaning);

    const rec = {
      chassis_family: 'F',                  // F-series; uppercase per join convention
      ecu_or_cafd,                          // "<ECU>:<0xCAFD>"
      ecu,                                  // ECU short name (FEM_BODY, IHKA, ...)
      cafd: cafdHex,                        // 0x-prefixed CAFD id
      fsw_label,                            // "<group>/<start>" locus
      value_label,                          // symbolic enum value or null
      value_hex,                            // 0x-prefixed byte value or null
      meaning,                              // human-readable function (code @description)
      group: groupId,                       // coding group id
      byte_start: start != null ? Number(start) : null,
      byte_end: end != null ? Number(end) : null,
      mask: a.mask != null ? a.mask : null, // bit mask, e.g. "00000010b"
      raw_value: rawValue || null,          // original write token as written in the cheat
      series: cafd && cafd.series ? cafd.series : null, // explicit F-series list when given
      comment: a.comment != null ? a.comment : null,
      source,
    };
    out.write(JSON.stringify(rec) + '\n');
    rows++;
    curFn = null;
  }

  for (const t of tokens(xml)) {
    if (t.type === 'open') {
      const n = t.name.toLowerCase();
      if (n === 'cafd') {
        cafd = {
          id: t.attrs.id || null,
          name: (t.attrs.name || '').trim() || null,
          series: (t.attrs.series || '').trim() || null,
        };
        if (cafd.series) cafd.series.split(',').forEach(s => { const v = s.trim().toUpperCase(); if (v) seriesSet.add(v); });
      } else if (n === 'code') {
        code = { description: (t.attrs.description != null ? t.attrs.description : '').trim() || null };
      } else if (n === 'group') {
        group = { id: t.attrs.id != null ? String(t.attrs.id).trim() : null };
      } else if (n === 'function') {
        emitFunction(); // flush any unterminated previous fn (defensive)
        curFn = { attrs: t.attrs, text: '' };
        if (t.selfClose) emitFunction();
      }
    } else if (t.type === 'text') {
      if (curFn) curFn.text += t.value;
    } else if (t.type === 'close') {
      const n = t.name.toLowerCase();
      if (n === 'function') emitFunction();
      else if (n === 'group') group = null;
      else if (n === 'code') code = null;
      else if (n === 'cafd') cafd = null;
    }
  }
  emitFunction(); // flush trailing

  out.end();

  out.on('finish', () => {
    if (rows === 0) caveats.push('No <function> rows parsed — file structure may have changed upstream.');
    caveats.push('All rows are F-series E-Sys FDL coding cheats from a single community catalog (FDLCodes.xml); they are FETCHED, not reconstructed.');
    caveats.push('chassis_family is the literal family "F"; per-row exact F-chassis (e.g. F020/F030) is only known when the cafd carries a series= attribute (captured in the `series` column), otherwise null.');
    caveats.push('fsw_label is the FDL locus "<group>/<start_byte>", the structural analog of an FSW; this catalog has no numeric SFA/FSW codes, so labels are group/byte addresses, not NCS FSW tokens.');
    caveats.push('value_label holds symbolic enum write tokens (e.g. Aktiv, Soft_On, TFL_S); value_hex holds raw byte writes as 0x.. ; exactly one of the two is set per non-empty row.');
    caveats.push('The commented-out <!-- Sample Only --> CAFD block in the source is intentionally excluded.');

    const report = {
      rows,
      distinct_ecus: ecuSet.size,
      distinct_cafds: cafdSet.size,
      distinct_fsw_labels: labelSet.size,
      distinct_meanings: meaningSet.size,
      distinct_value_labels: valLabelSet.size,
      hex_value_rows: hexVals,
      symbolic_value_rows: symbolicVals,
      empty_value_rows: emptyVals,
      series_seen: [...seriesSet].sort(),
      ecus: [...ecuSet].sort(),
      cafds: [...cafdSet].sort(),
    };
    log('REPORT ' + JSON.stringify(report));
    log('CAVEATS ' + JSON.stringify(caveats));
    log('OUT ' + OUT_FILE);
  });
}

main();
