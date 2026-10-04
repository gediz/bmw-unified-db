# Coverage: what to trust, and what is partial

The values are accurate. The coverage is uneven, and the honest numbers are in the `meta` table and
`index.json`. The ones that matter:

- Addressability. 949 of the 2,466 decoded ECUs have a routing entry, so the rest are described but not
  addressable from the phone book. `has_routing` flags this per ECU.
- Independent verification. 1,805 of the 2,466 decoded ECUs (73 percent) have a local original binary
  and were cross-checked against it. `has_local_binary` flags them. The other 661, including the
  G-series, are faithful to the decoded source but were not checked against BMW's binary.
- Coding. `has_coding` means the ECU supports the coding service, derived from its jobs. It does not
  mean this database holds coding values for it. Per-ECU coding values exist for only 7 decoded ECUs (25
  counting catalog stubs; the two donor cars). The large coding source is `coding_variant`, a
  chassis-wide catalog of 17,169 distinct function labels, keyed by chassis and coding block rather than
  by ECU. Use `has_coding_data` and `coding_example_count` for actual data presence. For F and G-series,
  `fdl_code` adds 2,674 community FDL coding labels (363 G-series) with byte/bit/value detail; it is
  community-curated from BMW PSdZData CAFD, so treat it as a guide, not a verified per-car source.
- English. Coding labels are mostly English. Fault text is largely German. 18,664 fault rows carry a
  genuine English translation in `location_text_en`; the rest are German because BMW only partially
  translated the source binaries. Rows that were byte-identical to the German were not treated as
  translations.
- Applicability. `vehicle_ecu` and `option_code` cover E-series and MINI only. There is no F, G, I, or U
  series SP-DATEN here.
- CAN and DS2. `can_*` covers the E8x/E9x chassis group. `ds2_*` covers the single MS43 engine module.
- Bus assignment. Message-level buses are high confidence. Per-ECU buses in `ecu_bus` are a heuristic
  from the ECU group name; the `confidence` column says which is which.
- Newer ECUs. 661 decoded ECUs, the G-series among them, have no local binary, so they could not be
  cross-checked against BMW's originals (see [VERIFICATION.md](VERIFICATION.md)).
- Wiring and repair text. Not present. The WDS and TIS source data is not in these repos.
