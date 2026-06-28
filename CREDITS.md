# Credits and data provenance

This database is a compilation. The parsers, schema, and assembler are original work under MIT (see
LICENSE). The data is extracted from the sources below, each credited here. If you redistribute
this database or build on it, keep this file and the attributions in it.

All layers are merged into one `bmw.sqlite`. The per-part licensing is also machine-readable inside
the database itself, in the `data_source` table (one row per layer with its origin, upstream,
license, SPDX id, and transformation). Two merged layers place obligations on the combined file:
`obd_signal` is CC-BY-SA-4.0 (share-alike) and `fdl_code` is GPL-3.0 (copyleft). Honor those for
those layers when redistributing the whole.

## Not affiliated with BMW

This project is not affiliated with, endorsed by, or connected to BMW AG. BMW, EDIABAS, INPA, NCS
Expert, ISTA, WinKFP, and the related marks are the property of BMW AG. The diagnostic, coding, and
routing data is derived from BMW's data for interoperability and right-to-repair purposes. If BMW AG
or a rights holder objects, open an issue or contact the maintainer and the affected data will be
removed.

## Where each layer comes from

Each layer is extracted from one source in this collection and reconciles to it.

| Layer | Source | Detail |
|---|---|---|
| Diagnostics: jobs, results, tables, fault dictionaries | [`ediabasx-docs-sgbd`](https://github.com/emdzej/ediabasx-docs-sgbd) | 2,466 decoded SGBD pages |
| Routing, English text, coding catalog, identification, flash, measurements | [`bmw-advanced-tools`](https://git.0x45.cz/em/bmw-advanced-tools) | the `T_GRTB.PRG` phone book, the `EnglishEcu` binaries, the SP-DATEN and CVT coding data, the WinKFP database, the INPA scripts |
| Coding examples and raw coding images | [`BMW_coding`](https://github.com/dzid26/BMW_coding), [`diesel-x5m`](https://github.com/yarik-vv/diesel-x5m) | one E82 and one E70 diesel |
| Legacy DS2 jobs and faults | [`j2534`](https://github.com/emdzej/j2534) | the M54 MS43 module |
| Live CAN messages, signals, values, checksums | [`opendbc`](https://github.com/BMW-E8x-E9x/opendbc), [`openpilot`](https://github.com/BMW-E8x-E9x/openpilot) | E8x/E9x |

## Source repositories in this collection

Attribution and license for each source. For what each one feeds, see
[Where each layer comes from](#where-each-layer-comes-from).

- [`ediabasx-docs-sgbd`](https://github.com/emdzej/ediabasx-docs-sgbd) by [emdzej](https://github.com/emdzej):
  BMW SGBD ECU descriptions, decoded from BMW EDIABAS SGBD binaries.
- [`bmw-advanced-tools`](https://git.0x45.cz/em/bmw-advanced-tools) (re-host; credit to
  [gushmazuko](https://github.com/gushmazuko)): a bundle of BMW's EDIABAS, INPA, NCS Expert, WinKFP, and
  SP-DATEN.
- [`opendbc`](https://github.com/BMW-E8x-E9x/opendbc): a community CAN database. A
  [comma.ai](https://github.com/commaai/opendbc) fork by the [BMW-E8x-E9x](https://github.com/BMW-E8x-E9x)
  org and [dzid26](https://github.com/dzid26). MIT.
- [`openpilot`](https://github.com/BMW-E8x-E9x/openpilot): the CAN bus map and checksum algorithms. A
  [comma.ai](https://github.com/commaai/openpilot) fork. MIT.
- [`j2534`](https://github.com/emdzej/j2534) by [emdzej](https://github.com/emdzej): the DS2 MS43 jobs
  and fault tables, reconstructed from a BMW SGBD. MIT.
- [`BMW_coding`](https://github.com/dzid26/BMW_coding) by [dzid26](https://github.com/dzid26): applied
  NCS coding for one E82 135i.
- [`diesel-x5m`](https://github.com/yarik-vv/diesel-x5m) by [yarik-vv](https://github.com/yarik-vv):
  applied NCS coding and raw coding images for one E70 diesel.

## Underlying data origin

The diagnostics, coding, routing, English, flash, and measurement layers originate from BMW AG data
(EDIABAS, SP-DATEN, SGBD, INPA, WinKFP). It is BMW copyrighted and is included here in decoded and
restructured form. See the not-affiliated notice above.

## External sources (added, kept under their own licenses)

Each lives in its own directory under its own license, is merged into `bmw.sqlite`, and is credited
here and in the `data_source` table:

- [OBDb](https://github.com/OBDb): live-data signal definitions and scaling. CC-BY-SA-4.0 (share-alike).
- [packetpilot/bmw-f](https://github.com/packetpilot/bmw-f) (`cheats/*.xml`): F/G-series FDL coding labels (2,674, de-duped). GPL-3.0; underlying values derive from BMW PSdZData CAFD.
- [NHTSA vPIC](https://vpic.nhtsa.dot.gov/): VIN structural decode. US public domain.
- [mytrile/obd-trouble-codes](https://github.com/mytrile/obd-trouble-codes): ISO 15031 / SAE J2012 generic codes. MIT.
- [python-udsoncan](https://github.com/pylessard/python-udsoncan) by pylessard: ISO 14229 standard data identifier names. MIT.
- [jakkuh/bmw-vin-decoder](https://github.com/jakkuh/bmw-vin-decoder): VIN parser reference. MIT.

## Tools

Built with Node's `node:sqlite` (SQLite). No third-party runtime dependencies.
