# Data model

How the layers join, and how to read a fault. Field-by-field column descriptions are in
[SCHEMA.md](SCHEMA.md), and runnable queries are in [COOKBOOK.md](COOKBOOK.md).

## One key for every layer

The join key for an ECU is `sgbd`, the lowercased SGBD name. It is the same across diagnostics, routing,
coding examples, flash, and measurements, so a single key pulls an ECU's data from every layer. Any
identifier, whether a part number, a routing group, a diagnostic address, an SGBD-index, or a family
name, resolves to that key first through `ecu_alias` and the `v_resolve` view.

Query by car using `chassis_variant` (1,771 links across 98 chassis) rather than parsing the `chassis`
JSON array. The `ecu_node` table groups variants into families (ACSM, DSC, DME) and records which layers
each family appears in.

## A worked example

Real output from the database:

```
$ resolve a hardware part number, then ask one ECU for everything
v_resolve  '4028612'  ->  abs56  (ABS / DSC unit)

v_ecu  'acsm3'  ->
  ecu_name        ACSM3 Zentrales Airbagauslösegerät für den F01, F02, F07, F10, F11, RR4
  ecu_family      ACSM        ecu_group   G_AIRBAG
  diag_address    0x1         bus         K-CAN
  dtc_count       849         measurement_count  287

one fault on acsm3, location + type:
  0x930900  ZK1 : Airbag Fahrer 1. Stufe : Plausibilitätsfehler
  0x05      Fehler momentan vorhanden und bereits gespeichert   (currently present, stored)
```

## A fault is three parts

The ECU reports a location code and a type code at runtime. `dtc` resolves the location, `dtc_type`
resolves the type, `dtc_class` gives the severity class, and `dtc_env` defines the freeze-frame fields
including their raw-to-engineering scaling (`value = raw * mul / div + add`).
