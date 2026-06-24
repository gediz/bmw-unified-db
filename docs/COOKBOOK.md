# Query cookbook

Runnable queries against `bmw.sqlite`. The eight views and the `ecu_alias` resolver cover the common
tasks, so most queries go through a `v_*` view rather than the base tables. Field-by-field column
descriptions are in [SCHEMA.md](SCHEMA.md).

Open the database with any SQLite client, or with Node 22 and no dependencies:

```js
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('dist/bmw.sqlite')
db.prepare('SELECT * FROM v_ecu WHERE sgbd = ?').get('acsm3')
```

## Resolve any identifier to its ECU

A hardware part number, a routing group, a diagnostic address, an SGBD-index, or a family name all
resolve through one table.

```sql
SELECT DISTINCT sgbd, ecu_name FROM v_resolve WHERE alias = '4028612';   -- part number
SELECT DISTINCT sgbd FROM v_resolve WHERE alias = 'G_AIRBAG';            -- group
SELECT DISTINCT sgbd FROM v_resolve WHERE alias = '0xF1020';             -- SGBD-index
```

## Everything about one ECU

```sql
SELECT * FROM v_ecu WHERE sgbd = 'acsm3';
```

Identify an ECU from a hardware part number, then pull its full record:

```sql
SELECT h.hwnr, h.ecu_type, e.*
FROM ecu_hwnr h JOIN v_ecu e ON e.sgbd = h.sgbd
WHERE h.hwnr = '4028612';
```

## Resolve a fault

The ECU reports a location code and a type code. Resolve each.

```sql
SELECT location_text, location_text_en FROM v_fault WHERE sgbd = 'acsm3' AND location_code = '0x930900';
SELECT type_text FROM dtc_type WHERE sgbd = 'acsm3' AND code = '0x05';
```

For a generic OBD2 code that is not BMW-specific:

```sql
SELECT description FROM generic_dtc WHERE code = 'P0301';
```

## Coding

List the codeable functions for a chassis, with English where known:

```sql
SELECT fsw_label, meaning_en, coding_block, fa_applicability
FROM v_coding WHERE chassis = 'E70' ORDER BY coding_block;
```

All coding from every source (chassis catalog, applied examples, F-series) in one surface:

```sql
SELECT scope, scope_key, fsw_label, meaning_en, source FROM v_coding_all WHERE scope_key = 'E70';
```

## Which ECUs a car has

```sql
SELECT ecu_group, sgbd, ecu_name FROM v_vehicle_ecu WHERE chassis = 'E70';
```

## Live measurements

Read a live measurement with its label, unit, and standard DID name:

```sql
SELECT result, label, unit, scale, offset, source FROM v_measurement WHERE sgbd = 'dde73kwp';
SELECT did, standard_name FROM v_did WHERE standard_name IS NOT NULL AND sgbd = 'acsm3';
```

## Decode a VIN

The structure is in `vin_wmi` (positions 1 to 3) and `vin_position` (the 17-character layout and the
year letter):

```sql
SELECT make, brand, country FROM vin_wmi WHERE wmi = 'WBA';
SELECT position, meaning FROM vin_position ORDER BY position;
```

## Full-text search

Across faults, coding labels, jobs, options, measurements, generic codes, and live signals:

```sql
SELECT kind, key, text FROM search WHERE search MATCH 'oil temperature' LIMIT 20;
```

## Provenance

Every layer carries its own origin and license in the `data_source` table:

```sql
SELECT layer, tables, license, transform FROM data_source ORDER BY spdx;
```
