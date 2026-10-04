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
  `fdl_code` adds 2,674 community FDL coding labels (268 G-series only, 95 shared with F) with byte/bit/value detail; it is
  community-curated from BMW PSdZData CAFD, so treat it as a guide, not a verified per-car source.
- English. Coding labels are mostly English. Fault text is largely German. 16,430 fault rows carry an
  English translation in `location_text_en`; the rest are German because BMW only partially translated
  the source binaries. Text that equals the German apart from a leading code, case, or spacing is not
  treated as a translation. Rows tagged `mixed` can still contain some German. The EnglishEcu tables for
  `dxc_90` and `dsc_89` drift out of step with their codes from `0x5DDF` and `0x9518` on (the text names
  another code), so those tails were dropped.
- Applicability. `vehicle_ecu` covers E-series and MINI only. `option_code` covers the same plus three BMW
  Motorrad AT files (K24, KH2, K1X). There is no F, G, I, or U series SP-DATEN here. E31, E32, and E34 come
  from the copies bundled under `DATEN/E39/`, because those chassis have no directory of their own.
  SP-DATEN has no separate directory for E81 to E88 or E90 to E93: they are coded under `E89`, so
  `vehicle_ecu` and `chassis_variant` file those cars under `E89`. Where a chassis has its own directory,
  coding data versions that only the older `DATEN/E39/` copy lists are not included.
- Freeze-frame scaling. `dtc_env` scaling is NULL for the `bms*` layouts whose third factor is a divisor,
  because the raw * mul / div + add form cannot express them without guessing.
- Routing ids. For older KWP and DS2 ECUs, `sgbd_index` holds a per-group variant id, not a global index.
  Use it together with `ecu_group`.
- Backup copies. A few SGBDs exist in the source as Windows backup copies (`kopie von msd80` and similar).
  They are kept as separate ECUs under their own key, with the original's family.
- CAN and DS2. `can_*` covers the E8x/E9x chassis group. `ds2_*` covers the single MS43 engine module.
- Bus assignment. Message-level buses are high confidence. Per-ECU buses in `ecu_bus` are a heuristic
  from the ECU group name; the `confidence` column says which is which.
- Newer ECUs. 661 decoded ECUs, the G-series among them, have no local binary, so they could not be
  cross-checked against BMW's originals (see [VERIFICATION.md](VERIFICATION.md)).
- Wiring and repair text. Not present. The WDS and TIS source data is not in these repos.
