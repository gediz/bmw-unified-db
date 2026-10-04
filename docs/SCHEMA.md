# Schema reference

The database has 46 tables and 8 views. This document describes each one and the columns that matter. For how the
data was sourced see the [README](../README.md), and how it was verified see [VERIFICATION.md](VERIFICATION.md).

## Conventions

- The ECU join key is `sgbd`, the lowercased SGBD name (for example `acsm3`). Every table whose key is
  `sgbd` resolves to a row in `ecu_variant`. (`ds2_*.ecu` and `coding_label.ecu` are module labels, not
  the `sgbd` key; `ds2_*` carry a `sgbd` column that does resolve.)
- Columns that hold a list are stored as JSON text: `uds_services`, `columns`, `cells`, `psw_values`,
  `psw_options`, `receivers`, `also_on`, and `chassis` in `ecu_variant`, `routing`, `option_code`,
  `ecu_bus`, and `coding_label`. In `vehicle_ecu`, `coding_variant`, `coding_example`, and
  `can_message`, `chassis` is a plain scalar string, not JSON. To filter by chassis across all ECUs,
  use the `chassis_variant` table.
- Hex values carry a `0x` prefix: `dtc.code`, `routing.diag_address`, `routing.sgbd_index`,
  `can_message.id_hex`, `ds2_*.code/id`, `ecu_bus.id_hex`.
- Booleans are `0` or `1`.
- `is_stub = 1` on `ecu_variant` marks an ECU known only from a catalog (routing, coding, flash,
  measurement) with no decoded SGBD page. Its content columns are empty.

## Diagnostics

`ecu_variant` is the spine, one row per ECU. Key columns: `sgbd` (primary key), `ecu_name`,
`chassis` (JSON array), `protocol` (UDS, KWP, DS2, or unknown), `is_uds`, `job_count`, `table_count`,
`ecu_family`, `file_kind`, and the capability and presence flags below.

Capability flags describe what the ECU supports, derived from its jobs: `has_coding`, `has_flash`,
`has_dtc`, `has_actuator`. Presence flags describe what this database holds for it: `has_routing`,
`has_coding_data`, `coding_example_count`. Do not read `has_coding` as "we have coding values"; that
is `has_coding_data`. `has_local_binary` is 1 when a local original EDIABAS binary exists for the ECU,
meaning it was cross-checked against BMW's data; it is 0 for ECUs decoded only from the Markdown
(including the G-series).

- `job` (`sgbd`, `name`): one diagnostic job. `description`, `mode`, `uds_services` (JSON array of
  `{service, name, did, subfn}`), `raw_services`.
- `uds_service` (`sgbd`, `job`): the parsed UDS service bytes, one row per service, with `protocol`.
- `job_arg`, `job_result` (`sgbd`, `job`, `name`): the arguments and results of a job, with `type`,
  `comment`, `ord`.
- `ecu_table` (`sgbd`, `name`): an SGBD lookup table. `rows`, `cols`, `columns` (JSON array of headers).
- `table_row` (`sgbd`, `table`, `idx`): every row of every table. `cells` is a JSON array. This is the
  raw layer that the fault dictionaries are derived from.

## Fault dictionaries

A runtime fault is a location code plus a type code. These four tables resolve it.

- `dtc` (`sgbd`, `code`): fault location. `location_text` (German), `location_text_en` (English where a
  genuine translation exists), `en_lang`, `event_dtc`, `source_table`.
- `dtc_type` (`sgbd`, `code`): fault type and status text. `type_text`.
- `dtc_class` (`sgbd`, `code`): fault severity class. `class_text`.
- `dtc_env` (`sgbd`, `code`): freeze-frame field definitions. `text`, `unit`, `name`, and the scaling
  `mul`, `div`, `add_offset` (engineering value = raw * mul / div + add_offset). The source tables use
  18 different column layouts, so these are mapped by column name, not by position. Where a layout
  carries no scaling columns, `mul`, `div`, and `add_offset` are null.

## English

The `EnglishEcu` binaries are only partially translated, so these are tagged by language.

- `english_dtc` (`sgbd`, `code`): English fault location text with a `lang` tag (`en`, `de`, `mixed`,
  `unknown`). Only `en` and `mixed` rows that differ from the German were merged into `dtc`.
- `english_job` (`sgbd`, `job`): the few English job descriptions recoverable as plain text.

## Routing

- `routing` (`sgbd`): the phone book. `ecu_group` (for example `G_AIRBAG`), `diag_address`
  (the ECU address, `ID_SG_ADR`), `sgbd_index` (the variant id, `ID_SGBD_INDEX`), `chassis`, `source`.
  Self-derived from the binary `T_GRTB.PRG`.

## Coding

- `coding_variant` (chassis-wide catalog): `chassis`, `fsw_label`, `fsw_index`, `psw_options` (JSON),
  `fa_applicability` (the S-code boolean expression, `+` is AND, `,` is OR, `!` is NOT), `coding_block`,
  `individ`. This is the main coding source, 17,169 distinct labels. It is keyed by chassis and coding
  block, not by ECU.
- `coding_label` (`ecu`, `fsw_label`): function labels with `psw_values` (JSON) and English `meaning`.
- `coding_example` (`source_car`, `ecu_module`, `fsw`): applied coding from the two donor cars, with
  `psw`, `fsw_meaning`, `psw_meaning`, `sgbd`.
- `coding_netto` (`source_car`, `ecu_module`): raw coding byte images. `address`, `length`, `bytes`,
  `state` (default or coded).

## Applicability

- `vehicle_ecu` (`chassis`, `ecu_group`): which ECUs are installed per chassis, with `sgbd` and `cbd`.
  E-series and MINI only.
- `option_code` (`code`): the SALAPA option dictionary. `meaning`, `keyword`, `chassis`, `kind`, `fa`.

## Identification and flash

- `ecu_hwnr` (`hwnr`): hardware part number to ECU. `ecu_type`, `sgbd`, `at_name`, `description`.
  9,043 mappings.
- `flash_map` (`ecu_type`): flash references. `sgbd`, `flash_program`, `sgid`, `description`, and
  `usage`, which is always `reference-only; do-not-flash`. See the [Safety section](../README.md#safety).

## Measurements

- `measurement` (`sgbd`): INPA live-data display definitions. `screen`, `job`, `result`, `label`,
  `unit`, `scale`, `type`, `format`. The `scale` is usually empty because the numeric scaling lives in
  the SGBD result computation, not in the INPA script. (The all-null `offset` column was dropped; the
  unified `v_measurement` view still carries an `offset`, populated for the OBDb live-signal rows.)

## Live CAN

- `can_message` (`chassis`, `id_dec`): `id_hex`, `name`, `length`, `tx_node`, `bus`,
  `is_checksum_protected`.
- `can_signal` (`message_id_dec`, `name`): `start_bit`, `length`, `byte_order`, `is_signed`, `factor`,
  `offset`, `min`, `max`, `unit`, `receivers`.
- `can_value` (`message_id_dec`, `signal`, `value`): the enumerated value labels.
- `can_checksum_algo` (`id_dec`): the checksum algorithm needed to build a valid frame. `algo`, `seed`.

## Legacy DS2

- `ds2_job` (`ecu`, `id`) and `ds2_fault` (`ecu`, `kind`, `code`): the MS43 K-line module.

## Translations

- `translation` (`token`): merged German to English coding dictionary from both `Translations.csv`
  files, 28,595 tokens. `meaning_en`, `source`, `meaning_alt`.

## External layers

These come from openly licensed sources and keep their own licenses: committed snapshots in `external/`
(OBDb, generic DTC), the pinned `bmw-f` repo (FDL), and tables embedded in their parsers (VIN, standard
DIDs). See [CREDITS.md](../CREDITS.md).

- `obd_signal` (`ecu_header`, `did_or_pid`): [OBDb](https://github.com/OBDb) live-data signals with
  scaling. `name`, `unit`, `scale`, `offset`, `bit_offset`, `bit_length`, `signed`, `values` (JSON
  enum). CC-BY-SA-4.0.
- `generic_dtc` (`code`): ISO 15031 / SAE J2012 generic OBD2 codes, from
  [mytrile/obd-trouble-codes](https://github.com/mytrile/obd-trouble-codes). `description`, `category`,
  `is_generic`. MIT.
- `vin_wmi` (`wmi`) and `vin_position` (`position`): BMW VIN structural decode
  ([NHTSA vPIC](https://vpic.nhtsa.dot.gov/) and ISO 3779). Public domain and ISO.
- `uds_did_standard` (`did`): ISO 14229 standard DataIdentifier names, from
  [python-udsoncan](https://github.com/pylessard/python-udsoncan). MIT.
- `fdl_code` (`ecu`, `fsw_label`): F/G-series FDL coding labels, 2,674 across 95 CAFDs, from the
  community cheat files in [packetpilot/bmw-f](https://github.com/packetpilot/bmw-f) `cheats/*.xml`
  (de-duped on the coding write). `series` is the per-chassis applicability; `chassis_family` is F, G, I,
  or RR derived from it; `byte_start`/`byte_end`/`mask`/`raw_value` are the write, `meaning` and `comment`
  the human text. GPL-3.0; the underlying values derive from BMW PSdZData CAFD definitions.

## Views

Eight views are the everyday surface. Use them instead of joining the base tables. See
[COOKBOOK.md](COOKBOOK.md) for runnable queries.

- `v_resolve`: the identity resolver. Any identifier (`alias`) maps to its ECU `sgbd` and name. Backed
  by `ecu_alias`, which holds 19,332 aliases of seven types: `sgbd`, `family`, `ecu_group`,
  `sgbd_index`, `diag_address`, `hwnr` (hardware part number), and `ecu_type`. This is how a part
  number, a group, or an address all resolve to one ECU.
- `v_ecu`: one row per ECU joining identity, family, chassis, routing address, group, bus, and the
  counts and flags.
- `v_fault`: the location dictionary per ECU with German and English text. Pair with `dtc_type` and
  `dtc_class` to resolve a full fault.
- `v_coding`: the chassis-wide coding catalog with English meanings joined from `translation` and
  `coding_label`.
- `v_coding_all`: every coding source in one surface, with a `scope` (chassis, car, or F-chassis), a
  `source`, and the label, value, applicability, and English meaning.
- `v_did`: the diagnostic DIDs we extracted, with a normalized `did_norm` form, cross-linked to their
  ISO 14229 standard names.
- `v_measurement`: INPA measurements and OBDb live signals in one surface.
- `v_vehicle_ecu`: which ECUs are installed per chassis, with names.

`ecu_alias` (`alias_type`, `alias`, `sgbd`) is the resolver's backing table. Identifiers are
normalized where it matters: DIDs carry a `did_norm` column (`0x` plus uppercase hex) on both
`uds_service` and `uds_did_standard` so the cross-link is exact rather than format-dependent.

## Cross-layer and search

- `ecu_node` (`node`): an ECU family unified across layers, with `has_diag`, `has_routing`, `has_can`,
  `has_ds2`, `has_coding`, `variant_count`.
- `chassis`, `chassis_variant`, `ecu_group`, `ecu_family_dim`: dimension tables.
- `meta` (`k`, `v`): one row, key `about`, holding source provenance, full row counts, coverage figures, and the
  flag semantics, as JSON.
- `search`: an FTS5 index over fault text, English fault text, jobs, coding labels, options, and
  measurements. Columns `kind`, `key`, `text`. Query with `WHERE search MATCH '...'`.

## JSON mirror

`dist/json/` mirrors the same data as flat files, for consumers that do not embed SQLite. Three shapes:

- `ecu-index.json`: a flat list of the addressable ECUs. Each entry carries `ecuGroup`, `protocol`,
  `isUds`, `diagAddress`, `sgbdIndex`, `sgbd`, `ecuName`, and `chassis`.
- `variants/<sgbd>.json`: one file per ECU, 3,083 in total. Each holds the ECU's identity, routing, bus,
  jobs, tables, the full fault list (location, type, class, and freeze-frame), measurements, hardware
  part numbers, flash references, coding examples and raw coding images, and English job text.
- `index.json`: the row counts and coverage figures, the same content as the `meta` table.
