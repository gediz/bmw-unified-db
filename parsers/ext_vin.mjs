#!/usr/bin/env node
// ext_vin.mjs — deterministic BMW VIN structural decode layer.
//
// SOURCE / LICENSE:
//   - NHTSA vPIC DecodeVin API (vpic.nhtsa.dot.gov) — US Government public domain.
//     Used to VALIDATE WMI -> make/brand/country/plant assignments for a handful of real-shape
//     VINs (see VALIDATED[] below). Those rows are marked source:"nhtsa-vpic".
//   - en.wikibooks.org "Vehicle Identification Numbers (VIN codes)" — CC BY-SA. Used for the
//     WMI -> brand mapping and the position-10 model-year letter table. Marked source:"wikibooks".
//   - jakkuh/bmw-vin-decoder (GitHub) — referenced as a structural cross-check for BMW VDS/VIS
//     layout. (Repo carries no SPDX license tag at fetch time; only ISO-standard *structure*
//     is used from it, never vehicle-specific values.)
//   - ISO 3779 / ISO 3780 — the 17-char VIN structure itself (WMI 1-3, VDS 4-9, VIS 10-17,
//     check digit at position 9, model-year char at position 10). Standard, marked
//     source:"iso-3779".
//
// WHAT THIS IS: a deterministic, vehicle-AGNOSTIC decoder layer. It encodes only standard /
//   structural facts: which WMI prefix belongs to which BMW-group brand & plant, and what each
//   of the 17 VIN positions means. It NEVER asserts a vehicle-specific value (e.g. it does not
//   claim "WBA3A5C5 == 328i"); model/engine live in BMW's proprietary VDS tables and are out of
//   scope for an openly-licensed layer.
//
// OUTPUT (streaming NDJSON):
//   build/external/vin_wmi.ndjson       { wmi, make, brand, country, plant_hint, source }
//   build/external/vin_position.ndjson  { position, meaning, source }
//
// JOIN CONVENTIONS: chassis/identifier tokens uppercase (WMI, model-year letters). No hex here
//   (VIN is alphanumeric, not a byte field), so the 0x- rule doesn't apply.
//
// ZERO-DEP, Node v22 ESM. Streams output. Reconstructed vs fetched is explicit per row.

import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const OUT_DIR = join(REPO, 'build', 'external');
const OUT_WMI = join(OUT_DIR, 'vin_wmi.ndjson');
const OUT_POS = join(OUT_DIR, 'vin_position.ndjson');

// ---------------------------------------------------------------------------
// (1) VALIDATED rows — every field below was confirmed against the live NHTSA
//     vPIC DecodeVin API in this session (real-shape VINs, check-digit ignored).
//     These carry source:"nhtsa-vpic".
// ---------------------------------------------------------------------------
const VALIDATED = [
  // wmi, make,        brand,        country,                plant_hint,                       sampleVin
  ['WBA', 'BMW',       'BMW',        'GERMANY',              'Munich, Germany',                'WBA3A5C50DF353967'],
  ['WMW', 'MINI',      'MINI',       'UNITED KINGDOM',       'Oxford, United Kingdom',         'WMWMF73569TX12345'],
  ['SCA', 'ROLLS-ROYCE','ROLLS-ROYCE','UNITED KINGDOM',      'Goodwood, England',              'SCA664S51AUX48648'],
  ['5UX', 'BMW',       'BMW',        'UNITED STATES',        'Spartanburg (Greer), SC, USA',   '5UXKR0C58F0K00000'],
  ['3MW', 'BMW',       'BMW',        'MEXICO',               'San Luis Potosi, Mexico',        '3MW5R1J05L8B00000'],
];

// ---------------------------------------------------------------------------
// (2) RECONSTRUCTED rows — well-established published BMW-group WMI assignments
//     (Wikibooks VIN/WMI page + manufacturer-published WMI usage). Structural,
//     not vehicle-specific. source:"wikibooks" (mapping origin) but flagged as
//     reconstructed via the `reconstructed` set below so caveats are exact.
//     Each is the standard documented usage of the prefix; no per-car claims.
// ---------------------------------------------------------------------------
const RECONSTRUCTED = [
  // BMW AG passenger / body styles, Germany
  ['WBS', 'BMW',        'BMW M',      'GERMANY',        'BMW M GmbH, Germany (M3/M4/M5/M2)'],
  ['WBX', 'BMW',        'BMW',        'GERMANY',        'BMW X (SAV) body, Germany'],
  ['WBY', 'BMW',        'BMW i',      'GERMANY',        'BMW i (i3/i-series), Germany'],
  ['WB5', 'BMW',        'BMW i',      'GERMANY',        'BMW i SAV body, Germany'],
  ['3MF', 'BMW',        'BMW',        'MEXICO',         'San Luis Potosi, Mexico'],
  // BMW Manufacturing USA (Spartanburg / Greer, South Carolina)
  ['4US', 'BMW',        'BMW',        'UNITED STATES',  'Spartanburg (Greer), SC, USA'],
  ['5UM', 'BMW',        'BMW M',      'UNITED STATES',  'BMW US Motorsport, Spartanburg, SC, USA'],
  ['5YM', 'BMW',        'BMW M',      'UNITED STATES',  'BMW M SAV (X5 M/X6 M), Spartanburg, SC, USA'],
  ['5YV', 'BMW',        'BMW',        'UNITED STATES',  'BMW SAV, Spartanburg, SC, USA'],
  // BMW Motorrad (motorcycles) — same group WMIs, different vehicle class
  ['WB1', 'BMW',        'BMW Motorrad','GERMANY',       'BMW Motorrad (motorcycles), Germany'],
  ['WB2', 'BMW',        'BMW Motorrad','GERMANY',       'BMW Motorrad (motorcycles), Germany'],
  ['WB3', 'BMW',        'BMW Motorrad','INDIA',         'BMW Motorrad built by TVS, India'],
  ['WB4', 'BMW',        'BMW Motorrad','CHINA',         'BMW Motorrad scooters by Loncin, China'],
  // MINI body variants
  ['WMZ', 'MINI',       'MINI',       'UNITED KINGDOM', 'MINI SAV body, Oxford, United Kingdom'],
  ['WMB', 'MINI',       'MINI',       'NETHERLANDS',    'MINI built by VDL Nedcar, Born, Netherlands'],
  // Rolls-Royce (BMW Group) — Goodwood
  ['SCB', 'ROLLS-ROYCE','ROLLS-ROYCE','UNITED KINGDOM', 'Goodwood, England (also legacy Bentley use)'],
  ['SLA', 'ROLLS-ROYCE','ROLLS-ROYCE','UNITED KINGDOM', 'Rolls-Royce SAV (Cullinan), Goodwood, England'],
  // BMW Brilliance Automotive — China joint venture
  ['LBV', 'BMW',        'BMW Brilliance','CHINA',       'BMW Brilliance (Shenyang), China'],
  ['LE4', 'BMW',        'BMW Brilliance','CHINA',       'BMW Brilliance (Shenyang), China'],
];

// ---------------------------------------------------------------------------
// (3) Position rules for the 17-char VIN. ISO 3779 / ISO 3780 structure.
//     WMI 1-3, VDS 4-9 (check digit at 9), VIS 10-17 (model-year char at 10,
//     plant at 11, serial 12-17). source:"iso-3779".
// ---------------------------------------------------------------------------
const POSITIONS = [
  [1,  'WMI char 1 — region/country of manufacture (W=Germany, S=UK, 4/5=USA, 3=Mexico, L=China)'],
  [2,  'WMI char 2 — manufacturer within region (B=BMW AG, M=MINI/BMW M, C=Rolls-Royce group)'],
  [3,  'WMI char 3 — vehicle type / division (A=car, S=M car, X=SAV, Y=i car, 1=Motorrad)'],
  [4,  'VDS char 1 — vehicle descriptor (model / series family); BMW-proprietary VDS encoding'],
  [5,  'VDS char 2 — vehicle descriptor (body / development series); BMW-proprietary'],
  [6,  'VDS char 3 — vehicle descriptor (engine / equipment); BMW-proprietary'],
  [7,  'VDS char 4 — vehicle descriptor (restraint / market variant); BMW-proprietary'],
  [8,  'VDS char 5 — vehicle descriptor (engine / drivetrain detail); BMW-proprietary'],
  [9,  'VDS char 6 — CHECK DIGIT (ISO 3779; 0-9 or X). Validates positions 1-8 and 10-17'],
  [10, 'VIS char 1 — MODEL YEAR letter/digit (position-10 code; see vin_model_year mapping)'],
  [11, 'VIS char 2 — PLANT code (assembly plant within the WMI manufacturer)'],
  [12, 'VIS char 3 — sequential production serial (high)'],
  [13, 'VIS char 4 — sequential production serial'],
  [14, 'VIS char 5 — sequential production serial'],
  [15, 'VIS char 6 — sequential production serial'],
  [16, 'VIS char 7 — sequential production serial'],
  [17, 'VIS char 8 — sequential production serial (low)'],
];

// ---------------------------------------------------------------------------
// (4) Position-10 model-year table (ISO 3779 cycle). Letters I,O,Q,U,Z and digit
//     0 are NOT used. The cycle repeats every 30 years (A=1980 and 2010, ...).
//     Emitted as extra context rows in vin_position.ndjson under a synthetic
//     "10:<char>" position key so the model-year decode travels with the layer.
//     source:"iso-3779" (table cross-checked vs Wikibooks model-year page).
// ---------------------------------------------------------------------------
const MY_CHARS = ['A','B','C','D','E','F','G','H','J','K','L','M','N','P','R','S','T','V','W','X','Y',
                  '1','2','3','4','5','6','7','8','9'];
function modelYearRows() {
  const rows = [];
  // base year for the first letter 'A' in the modern cycle is 1980; sequence advances by 1.
  let year = 1980;
  for (const ch of MY_CHARS) {
    const y2 = year + 30; // the same code repeats 30 years later
    rows.push([`10:${ch}`, `Model-year char '${ch}' -> ${year} or ${y2} (30-year cycle; I/O/Q/U/Z/0 unused)`]);
    year++;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// VIN check-digit validation (ISO 3779) — used only to sanity-check our sample
// VINs' structure, NOT emitted as data. Pure transliteration + weighting.
// ---------------------------------------------------------------------------
const TRANSLIT = {
  A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,
  S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,
  '0':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
};
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
function checkDigit(vin) {
  if (vin.length !== 17) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = TRANSLIT[vin[i]];
    if (v === undefined) return null;
    sum += v * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const wmiOut = createWriteStream(OUT_WMI);
  const posOut = createWriteStream(OUT_POS);

  const seen = new Set();
  let wmiRows = 0, validatedRows = 0, reconstructedRows = 0;

  // (1) validated WMI rows
  for (const [wmi, make, brand, country, plant_hint] of VALIDATED) {
    const key = wmi.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    wmiOut.write(JSON.stringify({
      wmi: key, make, brand, country, plant_hint, source: 'nhtsa-vpic',
    }) + '\n');
    wmiRows++; validatedRows++;
  }

  // (2) reconstructed WMI rows
  for (const [wmi, make, brand, country, plant_hint] of RECONSTRUCTED) {
    const key = wmi.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    wmiOut.write(JSON.stringify({
      wmi: key, make, brand, country, plant_hint, source: 'wikibooks',
    }) + '\n');
    wmiRows++; reconstructedRows++;
  }

  // (3) position rules
  let posRows = 0;
  for (const [position, meaning] of POSITIONS) {
    posOut.write(JSON.stringify({ position, meaning, source: 'iso-3779' }) + '\n');
    posRows++;
  }
  // (4) model-year context rows (position-10 sub-table)
  let myRows = 0;
  for (const [position, meaning] of modelYearRows()) {
    posOut.write(JSON.stringify({ position, meaning, source: 'iso-3779' }) + '\n');
    posRows++; myRows++;
  }

  wmiOut.end();
  posOut.end();

  // structural self-check on the validated VINs (reported, not emitted)
  const checks = VALIDATED.map(([wmi, , , , , vin]) => {
    const cd = checkDigit(vin);
    return { wmi, vin, computedCheckDigit: cd, vinChar9: vin ? vin[8] : null,
             checkOk: cd !== null && cd === vin[8] };
  });

  return new Promise((resolve) => {
    let done = 0;
    const finish = () => { if (++done === 2) resolve(); };
    wmiOut.on('finish', finish);
    posOut.on('finish', finish);
  }).then(() => ({
    wmiRows, validatedRows, reconstructedRows,
    positionRows: posRows, modelYearRows: myRows,
    distinctWmi: seen.size,
    checks,
    files: { vin_wmi: OUT_WMI, vin_position: OUT_POS },
  }));
}

main().then((report) => {
  process.stderr.write('\n=== REPORT ===\n' + JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
}).catch((e) => {
  process.stderr.write('FATAL ' + e.stack + '\n');
  process.exit(1);
});
