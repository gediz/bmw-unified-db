# Schema reference

The database has 47 tables and 8 views. This document describes each one and the columns that matter. For how the
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
  measurement) with no decoded SGBD page. Its content columns are empty, and its `ecu_name` is the ECU
  type from the flash database (usually the uppercased `sgbd`).

## Diagnostics

`ecu_variant` is the spine, one row per ECU. Key columns: `sgbd` (primary key), `ecu_name`,
`chassis` (JSON array), `protocol` (UDS, KWP, DS2, or unknown), `is_uds`, `job_count`, `table_count`,
`ecu_family`, `file_kind`, and the capability and presence flags below.

`ecu_family` groups variants by their SGBD name: the engine controllers are `DME` (petrol) and `DDE`
(diesel), and the flash-slot prefix is ignored, so `06msd80` is a `DME`. Group files (`file_kind = 'GRP'`)
have no family. `chassis` is the union of the SGBD's own text, every routing row, and the SP-DATEN
installation lists. `ecu_name` is BMW's INFO text; where that is only the SGBD id or empty, the single
routing name is used, and template placeholders are left NULL.

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
  `mul`, `div`, `add_offset` (engineering value = raw * mul / div + add_offset; a NULL `div` means 1 and a
  NULL `add_offset` means 0). The source tables use 18 different column layouts, so these are mapped by
  column name, not by position. Decimal commas in the source are stored with a dot. Older layouts with
  `UWF_A` and `UWF_B` map to `mul` and `add_offset`. The scaling is NULL where a layout has no scaling
  columns or where its meaning is ambiguous (the `bms*` layouts with a third `UWF_C` divisor). A `UWF_A`
  of 0 marks a status or placeholder field and is stored as NULL scaling.

## English

The `EnglishEcu` binaries are only partially translated, so these are tagged by language.

- `english_dtc` (`sgbd`, `code`): English fault location text with a `lang` tag (`en`, `de`, `mixed`,
  `unknown`). Only `en` and `mixed` rows that differ from the German, apart from a leading code, case, or
  spacing, were merged into `dtc`. A row is merged from its own table (`FORTTEXTE` or `IORTTEXTE`); text
  from the other table is used only when that table has the same German for the code, or none.
- `english_job` (`sgbd`, `job`): the few English job descriptions recoverable as plain text.

## Routing

- `routing` (`sgbd`): the phone book. `ecu_group` (for example `G_AIRBAG`), `diag_address`
  (the ECU address, `ID_SG_ADR`, at least two hex digits such as `0x07`), `sgbd_index`, `chassis`,
  `source`. Self-derived from the binary `T_GRTB.PRG` (`source = 'prg'`) and the SP-DATEN SGET files
  (`source = 'spdaten'`). For UDS ECUs `sgbd_index` is the real `ID_SGBD_INDEX`. For older KWP and DS2
  rows the source only has a per-group variant id in that position (short values such as `0x1`), which is
  unique only together with `ecu_group`. An ECU can have several routing rows.

## Engine codes

- `ecu_engine` (`sgbd`, `engine`): the engine codes BMW's own ECU name mentions, for example
  `MS 43.0 fuer M54 mit EWS 3` gives `M54`. `engine` is the engine family (`M57`), `engine_variant` the
  code as written (`M57TUE2`). `relation` is `engine_ecu` when the module is the engine controller and
  `fitted_with` when it names the engine of the car it is fitted to (an ASC or DSC unit). Only real BMW
  engine families are kept, so Bosch part names such as `M401` never match, and a code right after the
  Siemens unit prefix (`MS S65`) is the unit's name, not its engine. `source` is `ecu_name`, or `routing`
  when the ECU's own name names no engine and BMW's routing name does. Derived in this repo; no outside
  source.

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

- `vehicle_ecu` (`chassis`, `ecu_group`): which ECUs are installed per chassis, with `sgbd`,
  `ecu_variant`, `cbd`, and `source_file`. E-series and MINI only. Each chassis is read from its own
  SP-DATEN directory; the copies bundled under `DATEN/E39/` are used only for E31, E32, and E34, which have
  no directory of their own. Rows from `*SGVT` files are version records with a NULL `sgbd`.
- `option_code` (`code`): the SALAPA option dictionary. `meaning`, `keyword`, `chassis`, `kind`, `fa`.
  Also holds BMW Motorrad AT files. `K1X` is a Motorrad file-family code shared by several bike models,
  not a single chassis.

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
- `vin_wmi` (`wmi`) and `vin_position` (`position`): BMW VIN structural decode. Rows with
  `source = 'nhtsa-vpic'` come from [NHTSA vPIC](https://vpic.nhtsa.dot.gov/) (public domain). Rows with
  `source = 'wikibooks'` come from the Wikibooks VIN page (CC BY-SA). Positions follow ISO 3779.
- `uds_did_standard` (`did`): ISO 14229 standard DataIdentifier names, from
  [python-udsoncan](https://github.com/pylessard/python-udsoncan). MIT.
- `fdl_code` (`ecu`, `fsw_label`): F/G-series FDL coding labels, 2,674 across 95 CAFDs, from the
  community cheat files in [packetpilot/bmw-f](https://github.com/packetpilot/bmw-f) `cheats/*.xml`
  (de-duped on the coding write). `series` is the per-chassis applicability; `chassis_family` is F, G, I,
  or RR derived from it; `byte_start`/`byte_end`/`mask`/`raw_value` are the write, `meaning` and `comment`
  the human text. GPL-3.0; the underlying values derive from BMW PSdZData CAFD definitions.
  `chassis_family` is NULL when the cheat file names no series (505 rows) or names an I-step platform
  such as `S18A` rather than a chassis (113 rows); the raw `series` value is kept.

## Views

Eight views are the everyday surface. Use them instead of joining the base tables. See
[COOKBOOK.md](COOKBOOK.md) for runnable queries.

- `v_resolve`: the identity resolver. Any identifier (`alias`) maps to its ECU `sgbd` and name. Backed
  by `ecu_alias`, which holds 18,640 aliases of eight types: `sgbd`, `family`, `ecu_group`,
  `sgbd_index`, `diag_address`, `hwnr` (hardware part number), `ecu_type`, and `engine`. This is how a
  part number, a group, an address, or an engine code all resolve to one ECU. Lookups are
  case-sensitive; use `COLLATE NOCASE` for a case-insensitive match. Filter on `alias_type` for hex
  values, which can be both an address and a variant id.
- `v_ecu`: one row per ECU joining identity, family, chassis, routing address, group, bus, engine codes
  (`engines`), and the counts and flags. When an ECU has several routing rows, `ecu_group`,
  `diag_address`, and `sgbd_index` come from one representative row (T_GRTB first) and `routing_count`
  says how many there are.
- `v_fault`: the location dictionary per ECU with German and English text. Pair with `dtc_type` and
  `dtc_class` to resolve a full fault.
- `v_coding`: the chassis-wide coding catalog with English meanings joined from `translation` and
  `coding_label`.
- `v_coding_all`: every coding source in one surface, with a `scope` (chassis, car, or F-chassis), a
  `source`, and the label, value, applicability, and English meaning.
- `v_did`: the diagnostic DIDs we extracted, with a normalized `did_norm` form, cross-linked to their
  ISO 14229 standard names.
- `v_measurement`: INPA measurements and OBDb live signals in one surface.
- `v_vehicle_ecu`: which ECUs are installed per chassis, with names, variant, `cbd`, and source file.

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
- `variants/<sgbd>.json`: one file per ECU, 3,083 in total. Each holds the ECU's identity, routing (the
  representative row, plus every row in `routes`), bus, engine codes (`engines`), jobs, tables, the full fault list (location, type, class, and freeze-frame), measurements, hardware
  part numbers, flash references, coding examples and raw coding images, and English job text.
- `index.json`: the row counts and coverage figures, the same content as the `meta` table.
