# External source: FDL (F/G-series E-Sys FDL coding cheats)

## Upstream

- Repository: https://github.com/packetpilot/bmw-f
- Files: the whole `cheats/` directory (21 contributor XML files, not just `FDLCodes.xml`)
- Pinned commit: `7db51ef8d1fe` (in `sources.json` as repo `bmw-f`)
- The mirror `botho/TokenMaster-Launcher-FDL` is byte-identical to this `cheats/` folder but carries no
  license, so we source from `packetpilot/bmw-f` (GPL) only.

## License

- **GPL-3.0** (declared by the upstream repo; see `LICENSE.md` there).
- The underlying byte/mask/value data derives from BMW PSdZData CAFD definitions (BMW copyrighted);
  the GPL covers the community compilation. Tagged with its license in the `data_source` table and kept
  removable on request like the other BMW-derived layers.

## What it is

E-Sys "FDL coding cheat" catalogs for BMW **F and G-chassis** vehicles, contributed by the coding
community. Each entry maps a human-readable coding function to the concrete byte/bit write inside a CAFD
container:

```
<cafd id="00000794" name="FEM_BODY" series="F020,F030">
  <code description="Auto Start/Stop Always Off">
    <group id="3023">
      <function start="0" end="0" mask="00010000b">Aktiv</function>
    </group>
  </code>
  ...
</cafd>
```

The `cafd @author` handle is a person attribution and is intentionally not ingested.

## Parser / output

- Parser: `parsers/ext_fdl_f.mjs` (zero-dependency Node ESM).
- Output: `build/external/fdl_code.ndjson`
- Schema per row:
  `{ chassis_family, ecu_or_cafd, ecu, cafd, fsw_label, value_label, value_hex, meaning,
     group, byte_start, byte_end, mask, raw_value, series, comment, source }`
- One row per `<function>` write. `chassis_family` is derived from the cafd `series` (F/G/I/RR).
  Rows are de-duped on `(cafd, group, byte_start, byte_end, mask, raw_value)` because contributors copy
  each other. Coverage at the pinned commit: 21 files, 95 CAFDs, ~5,300 raw writes, 2,674 after de-dup
  (363 G-series). Chassis tokens are uppercase; hex values are `0x`-prefixed.

## Retrieval

- Fetched via `fetch-sources.mjs` (clones the pinned commit into `sources/bmw-f`); the parser reads
  `sources/bmw-f/cheats/*.xml`. Rows are **fetched**, not reconstructed.
- Commented-out `<!-- Sample Only -->` CAFD blocks in the source are intentionally excluded.
