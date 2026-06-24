#!/usr/bin/env node
// ext_uds_did.mjs — zero-dep Node ESM parser (Node v22)
//
// External, openly-licensed data layer: ISO 14229 (UDS) standardized
// DataIdentifier (DID) names — the *generic* meaning of DIDs such as
//   0xF190 VIN, 0xF18C ECUSerialNumber, the whole 0xF1xx identification block,
// plus the documented ISO 14229-1 DID *range* categories (Periodic 0xF2xx,
// DynamicallyDefined 0xF3xx, OBD 0xF4xx..0xF8xx, Tachograph 0xF9xx,
// Airbag/Safety 0xFAxx, ReservedForLegislativeUse, SystemSupplierSpecific
// 0xFDxx..0xFExx, ISOSAEReserved 0xFFxx, etc).
//
// SOURCE OF TRUTH (fetched, MIT-licensed):
//   pylessard/python-udsoncan -> udsoncan/common/dids.py  (DataIdentifier class)
//   https://raw.githubusercontent.com/pylessard/python-udsoncan/master/udsoncan/common/dids.py
//   License: MIT (SPDX: MIT, repo LICENSE.txt). Same names verified against the
//   py-uds knowledge-base DID table (uds.readthedocs.io).
//
// The DID names + range categories below are transcribed VERBATIM from that
// MIT source. These are STANDARD / STRUCTURAL identifiers defined by ISO 14229,
// NOT vehicle-specific values. Vehicle-manufacturer-specific ranges are emitted
// only as range descriptors (e.g. 0xF100-0xF17F "IdentificationOptionVehicle
// ManufacturerSpecific"), never as fabricated concrete DID->value mappings.
//
// CROSS-LINK: out rows key on `did` (e.g. "0xF190") so they join our
// uds_service.did column. We keep universal join conventions: hex values are
// uppercase and 0x-prefixed.
//
// Output (streaming NDJSON):
//   build/external/uds_did_standard.ndjson
//     { did, name, range_note, source }
//   where `did` is either a single id "0xF190" or a range "0xF100-0xF17F".
//
// Robustness: this layer has no external file inputs at run time — the table is
// the captured-from-source constant below — so there is nothing to skip-and-log;
// we still validate counts + uniqueness and surface any anomaly as a caveat.

import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(import.meta.dirname, "..", "build", "external");
const OUT_PATH = path.join(OUT_DIR, "uds_did_standard.ndjson");

const SRC = "pylessard/python-udsoncan (MIT) udsoncan/common/dids.py";

const log = [];
const warn = (m) => log.push(m);

// ---- tiny streaming NDJSON writer (matches sibling parsers) ----
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
  };
}

// Normalize any 16-bit DID to the universal "0x" + 4 uppercase hex digits form.
const hx = (v) => "0x" + v.toString(16).toUpperCase().padStart(4, "0");

// =====================================================================
// (1) Named single DIDs — the standardized 0xF18x..0xF19x identification block.
//     Transcribed verbatim from udsoncan/common/dids.py (MIT).
//     range_note here carries the short human meaning (kept terse, standard).
// =====================================================================
const NAMED = [
  [0xF180, "BootSoftwareIdentification", "Boot software identification"],
  [0xF181, "ApplicationSoftwareIdentification", "Application (downloadable) software identification"],
  [0xF182, "ApplicationDataIdentification", "Application data identification"],
  [0xF183, "BootSoftwareFingerprint", "Boot software fingerprint"],
  [0xF184, "ApplicationSoftwareFingerprint", "Application software fingerprint"],
  [0xF185, "ApplicationDataFingerprint", "Application data fingerprint"],
  [0xF186, "ActiveDiagnosticSession", "Active diagnostic session (echoes current session, 1 byte)"],
  [0xF187, "VehicleManufacturerSparePartNumber", "Vehicle manufacturer spare part number"],
  [0xF188, "VehicleManufacturerECUSoftwareNumber", "Vehicle manufacturer ECU software number"],
  [0xF189, "VehicleManufacturerECUSoftwareVersionNumber", "Vehicle manufacturer ECU software version number"],
  [0xF18A, "SystemSupplierIdentifier", "System supplier identifier"],
  [0xF18B, "ECUManufacturingDate", "ECU manufacturing date (YYYYMMDD, BCD)"],
  [0xF18C, "ECUSerialNumber", "Server's unique ECU serial number"],
  [0xF18D, "SupportedFunctionalUnits", "Supported functional units"],
  [0xF18E, "VehicleManufacturerKitAssemblyPartNumber", "Vehicle manufacturer kit assembly part number"],
  [0xF18F, "ISOSAEReservedStandardized", "ISO/SAE reserved (standardized)"],
  [0xF190, "VIN", "Vehicle Identification Number (ISO 3779, 17 chars)"],
  [0xF191, "VehicleManufacturerECUHardwareNumber", "Vehicle manufacturer ECU hardware number"],
  [0xF192, "SystemSupplierECUHardwareNumber", "System supplier ECU hardware number"],
  [0xF193, "SystemSupplierECUHardwareVersionNumber", "System supplier ECU hardware version number"],
  [0xF194, "SystemSupplierECUSoftwareNumber", "System supplier ECU software number"],
  [0xF195, "SystemSupplierECUSoftwareVersionNumber", "System supplier ECU software version number"],
  [0xF196, "ExhaustRegulationOrTypeApprovalNumber", "Exhaust regulation or type approval number"],
  [0xF197, "SystemNameOrEngineType", "System name or engine type"],
  [0xF198, "RepairShopCodeOrTesterSerialNumber", "Repair shop code or tester serial number"],
  [0xF199, "ProgrammingDate", "Programming date (YYYYMMDD, BCD)"],
  [0xF19A, "CalibrationRepairShopCodeOrCalibrationEquipmentSerialNumber", "Calibration repair shop code or calibration equipment serial number"],
  [0xF19B, "CalibrationDate", "Calibration date (YYYYMMDD, BCD)"],
  [0xF19C, "CalibrationEquipmentSoftwareNumber", "Calibration equipment software number"],
  [0xF19D, "ECUInstallationDate", "ECU installation date (YYYYMMDD, BCD)"],
  [0xF19E, "ODXFile", "ODX file (diagnostic description)"],
  [0xF19F, "Entity", "Entity identifier"],
];

// =====================================================================
// (2) Range categories — the ISO 14229-1 DID address-space partitioning,
//     transcribed verbatim from DataIdentifier.name_from_id() in the same
//     MIT source. These describe the *meaning of an address range*, never a
//     concrete vehicle value. `did` carries the inclusive "0xLO-0xHI" range.
// =====================================================================
const RANGES = [
  [0x0000, 0x00FF, "ISOSAEReserved", "ISO/SAE reserved range"],
  [0x0100, 0xEFFF, "VehicleManufacturerSpecific", "Vehicle manufacturer specific (largest VM-defined block)"],
  [0xF000, 0xF00F, "NetworkConfigurationDataForTractorTrailerApplicationDataIdentifier", "Network configuration data for tractor/trailer application"],
  [0xF010, 0xF0FF, "VehicleManufacturerSpecific", "Vehicle manufacturer specific"],
  [0xF100, 0xF17F, "IdentificationOptionVehicleManufacturerSpecificDataIdentifier", "Identification option, vehicle manufacturer specific"],
  // 0xF180..0xF19F are the named identification block (emitted individually above).
  [0xF1A0, 0xF1EF, "IdentificationOptionVehicleManufacturerSpecific", "Identification option, vehicle manufacturer specific"],
  [0xF1F0, 0xF1FF, "IdentificationOptionSystemSupplierSpecific", "Identification option, system supplier specific"],
  [0xF200, 0xF2FF, "PeriodicDataIdentifier", "Periodic data identifier (ReadDataByPeriodicIdentifier 0x2A)"],
  [0xF300, 0xF3FF, "DynamicallyDefinedDataIdentifier", "Dynamically defined data identifier (DynamicallyDefineDataIdentifier 0x2C)"],
  [0xF400, 0xF4FF, "OBDDataIdentifier", "OBD data identifier"],
  [0xF500, 0xF5FF, "OBDDataIdentifier", "OBD data identifier"],
  [0xF600, 0xF6FF, "OBDMonitorDataIdentifier", "OBD monitor data identifier"],
  [0xF700, 0xF7FF, "OBDMonitorDataIdentifier", "OBD monitor data identifier"],
  [0xF800, 0xF8FF, "OBDInfoTypeDataIdentifier", "OBD info-type data identifier"],
  [0xF900, 0xF9FF, "TachographDataIdentifier", "Tachograph data identifier"],
  [0xFA00, 0xFA0F, "AirbagDeploymentDataIdentifier", "Airbag deployment data identifier"],
  [0xFA10, 0xFAFF, "SafetySystemDataIdentifier", "Safety system data identifier"],
  [0xFB00, 0xFCFF, "ReservedForLegislativeUse", "Reserved for legislative use"],
  [0xFD00, 0xFEFF, "SystemSupplierSpecific", "System supplier specific"],
  [0xFF00, 0xFFFF, "ISOSAEReserved", "ISO/SAE reserved range"],
];

// =====================================================================
// (3) Service refs — well-known UDS services that operate on DIDs, kept as
//     non-DID structural reference rows so the layer self-documents the
//     0x22 / 0x2E / 0x2A / 0x2C / 0x10 relationships mentioned in the task.
//     These use a "svc:0xNN" key (NOT a 16-bit DID) so they never collide
//     with real DIDs and are easy to filter out at join time.
//     Names/IDs are ISO 14229-1 standard service identifiers (MIT source +
//     ISO 14229-1 service table).
// =====================================================================
const SERVICE_REFS = [
  ["0x10", "DiagnosticSessionControl", "Service that selects the session in which DIDs become readable/writable"],
  ["0x22", "ReadDataByIdentifier", "Primary service to read a DID's value (request DID, response = DID + data)"],
  ["0x2A", "ReadDataByPeriodicIdentifier", "Reads periodic DIDs from the 0xF2xx range"],
  ["0x2C", "DynamicallyDefineDataIdentifier", "Defines dynamic DIDs in the 0xF3xx range"],
  ["0x2E", "WriteDataByIdentifier", "Writes a DID's value"],
  ["0x3D", "WriteMemoryByAddress", "Memory write (DID-adjacent identification/calibration flows)"],
];

async function build() {
  const w = openWriter(OUT_PATH);
  const seen = new Set();

  // (1) named DIDs
  for (const [id, name, note] of NAMED) {
    const did = hx(id);
    if (seen.has(did)) { warn(`duplicate named DID ${did} skipped`); continue; }
    seen.add(did);
    w.write({ did, name, range_note: note, source: SRC });
  }

  // (2) ranges
  for (const [lo, hi, name, note] of RANGES) {
    const did = `${hx(lo)}-${hx(hi)}`;
    if (seen.has(did)) { warn(`duplicate range ${did} skipped`); continue; }
    seen.add(did);
    w.write({ did, name, range_note: `range: ${note}`, source: SRC });
  }

  // (3) service refs
  for (const [svc, name, note] of SERVICE_REFS) {
    const did = `svc:${svc}`;
    w.write({ did, name, range_note: `service-ref: ${note}`, source: `ISO 14229-1 service id; ${SRC}` });
  }

  const { rows, samples } = await w.close();

  // ---- validation ----
  if (NAMED.length !== 32) warn(`expected 32 named F18x/F19x DIDs, got ${NAMED.length}`);
  const f190 = NAMED.find(([id]) => id === 0xF190);
  if (!f190 || f190[1] !== "VIN") warn("sanity check failed: 0xF190 is not VIN");
  const f18c = NAMED.find(([id]) => id === 0xF18C);
  if (!f18c || f18c[1] !== "ECUSerialNumber") warn("sanity check failed: 0xF18C is not ECUSerialNumber");
  // every named id must fall inside the identification block 0xF180-0xF19F
  for (const [id] of NAMED) {
    if (id < 0xF180 || id > 0xF19F) warn(`named DID ${hx(id)} outside 0xF180-0xF19F identification block`);
  }

  return {
    outPath: OUT_PATH,
    rows,
    samples,
    counts: { named: NAMED.length, ranges: RANGES.length, service_refs: SERVICE_REFS.length },
  };
}

async function main() {
  const r = await build();
  const report = {
    parser: "ext_uds_did",
    files: [{ entity: "uds_did_standard", path: r.outPath, rows: r.rows }],
    totals: {
      uds_did_standard: r.rows,
      named_dids: r.counts.named,
      range_descriptors: r.counts.ranges,
      service_refs: r.counts.service_refs,
    },
    caveats: log,
    sampleRows: { uds_did_standard: r.samples },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
