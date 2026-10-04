# OBDb: community OBD2/UDS signal definitions (live-data scaling)

- **Upstream:** https://github.com/OBDb  (per-model repos `OBDb/BMW-*`)
- **Files used:** `signalsets/v3/default.json` in each `OBDb/BMW*` repo, fetched raw from
  `https://raw.githubusercontent.com/OBDb/<repo>/main/signalsets/v3/default.json`
- **License:** CC-BY-SA-4.0 (Creative Commons Attribution-ShareAlike 4.0 International).
  Attribution to the OBDb project is required; derived data must remain share-alike.
- **Retrieved:** 2026-06-24
- **Build input:** the committed snapshot `external/obdb/obd_signal.ndjson` (663 signals). The build copies
  it and does not touch the network. `node parsers/ext_obdb.mjs --refresh` re-fetches from the unpinned
  upstream `main` branches and rewrites the snapshot, which changes the database; commit that diff deliberately.
- **Parser:** `parsers/ext_obdb.mjs` (zero-dep Node ESM)
- **Output:** `build/external/obd_signal.ndjson`

## Why this layer

OBDb fills the unified DB's live-data scaling gap with OPEN data. BMW/EDIABAS-derived
layers describe *which* result a job returns but not the openly-publishable raw→engineering
decode. OBDb signal definitions carry exactly that: bit offset/length, divisor/multiplier,
additive offset, sign, unit, and value-enum maps for status signals.

## How the snapshot was fetched

The org-level repo listing (`GET /orgs/OBDb/repos`) is unioned with a built-in fallback
list of 38 known `BMW*` repos. Each repo's `signalsets/v3/default.json` is fetched and
flattened to one NDJSON row per signal.

At last run: **38 BMW repos considered, 38 fetched, 15 contained signal data, 663 signals
emitted.** The remaining 23 repos (e.g. `BMW-E91`, `BMW-E92`, `BMW-F34`, `BMW-Z3`,
`BMW-M3`, model-marketing stubs) ship an empty `{"commands": []}` upstream and therefore
contribute no rows. This is an upstream state, not a parse failure.

## Schema mapping (OBDb v3 → obd_signal.ndjson)

A command groups signals that share one request:

| OBDb field        | meaning                                   | unified column           |
|-------------------|-------------------------------------------|--------------------------|
| `rax` (else `hdr`)| ECU response address / request header     | `ecu_header` (0x-hex)    |
| `cmd {svc:payload}`| UDS/OBD service + DID/PID, e.g. `{"22":"DD68"}` | `did_or_pid` = `0x22DD68` |
| `signal.name`     | human label                               | `name`                   |
| `fmt.bix`         | bit offset into payload (default 0)       | `bit_offset`             |
| `fmt.len`         | bit length                                | `bit_length`             |
| `fmt.mul`/`fmt.div`| scale = mul/div                          | `scale`                  |
| `fmt.add`         | additive offset                           | `offset`                 |
| `fmt.sign`        | two's-complement signed                   | `signed`                 |
| `fmt.unit`        | engineering unit token                    | `unit`                   |
| `fmt.map`         | `{raw: {value, description}}` enum table  | `values` (JSON `{raw:ENUM}`) |
| repo name         | `BMW`, `BMW-3-Series`, `BMW-E91`, …       | `model`, `chassis_hint`  |

**Decode formula:** `engineering = raw * scale + offset` (scale defaults 1, offset 0).

## Join conventions

- `ecu_header` and `did_or_pid` are `0x`-prefixed UPPERCASE hex.
- `chassis_hint` is the UPPERCASE chassis token only when the repo name *is* a chassis code
  (`E\d+`, `F\d+`, `G\d+`, `U\d+`, `I\d{2}`, `RR\d+`); model/marketing-named repos resolve
  to `null` because they span multiple chassis. (As of last run, all chassis-coded repos
  were empty upstream, so every emitted row has `chassis_hint = null`.)
- `model` is `null` for the cross-model `OBDb/BMW` repo (shared defaults).

## Attribution (CC-BY-SA-4.0)

Signal definitions © the OBDb contributors, licensed CC-BY-SA-4.0. See each
`OBDb/BMW*` repository for contributor credits.
