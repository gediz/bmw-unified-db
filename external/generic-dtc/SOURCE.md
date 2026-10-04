# generic-dtc: Generic OBD-II Diagnostic Trouble Codes (ISO 15031 / SAE J2012)

The standard P/C/B/U trouble-code dictionary that the BMW-specific SGBD corpus
lacks. Joins to the rest of the unified DB via the 5-character DTC token
(e.g. `P0301`), which is what scan tools print and what BMW UDS "read DTC"
responses carry for the OBD subset.

## Upstream

- Repository: https://github.com/mytrile/obd-trouble-codes
- Raw file used: https://raw.githubusercontent.com/mytrile/obd-trouble-codes/master/obd-trouble-codes.csv
- Format: RFC-4180 CSV, two columns: `"CODE","Description"`.
- We prefer the CSV over the repo's JSON: the upstream JSON reuses the first
  row's keys (`"P0100"` and the first description) as the object keys for *every*
  row, so only the JSON *values* are meaningful. The CSV is the unambiguous
  canonical form.

## License

MIT: Copyright (c) 2014 Dimitar Kostov. Full text preserved alongside this file
as `LICENSE`. The underlying code/description content is the public
ISO 15031 / SAE J2012 standard P/C/B/U dictionary.

## Retrieval

- Retrieved: 2026-06-24.
- The build reads only the copy committed in this folder (`obd-trouble-codes.csv`),
  so it is reproducible without network access. If that file is missing, the parser
  falls back to a live fetch of the unpinned upstream `master` CSV, then JSON, then to
  a small reconstructed standard-P0 block (tagged `reconstructed:ISO15031/SAEJ2012`).
  Either fallback changes the database, so keep the file committed.

## Build

- Parser: `parsers/ext_generic_dtc.mjs` (zero-dep, Node ESM, Node v22).
- Output: `build/external/generic_dtc.ndjson`
- Row shape: `{ code, description, category, is_generic, source }`
  - `code`: uppercase, validated `^[PCBU][0-9A-F]{4}$` (e.g. `P0301`).
  - `category`: `P` | `C` | `B` | `U` (first char of the code).
  - `is_generic`: `1` when the 2nd char is `0` or `2` (manufacturer-independent
    ISO/SAE ranges), else `0` (manufacturer-specific `1`/`3` ranges).
  - `source`: `mytrile/obd-trouble-codes@master (MIT)` for fetched rows.

## Caveats

- This 2014 community compilation is most complete for **P** codes
  (`P0100` to `P1918`). Its **C/B/U** rows skew to manufacturer-specific
  ranges (`C1xxx`, `B1xxx`, `U1xxx`; Ford-heavy) and it does **not** include the
  SAE-generic `C0xxx` / `B0xxx` / `U0xxx` network blocks (e.g. `U0100` is absent).
- Some descriptions reflect this source's wording rather than the latest J2012
  text (e.g. `P0301` here reads "Random/Multiple Cylinder Misfire Detected").
  The **codes** are correct standard tokens; treat the prose as indicative.
- No BMW-specific or otherwise vehicle-specific values were added: standard /
  structural data only.
