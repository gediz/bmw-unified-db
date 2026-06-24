# External source: FDL-F (F-series E-Sys FDL coding cheats)

## Upstream

- Repository: https://github.com/packetpilot/bmw-f
- File: `cheats/FDLCodes.xml`
- Raw URL: https://raw.githubusercontent.com/packetpilot/bmw-f/master/cheats/FDLCodes.xml
- Branch: `master`

## License

- **GPL-3.0** (declared by the upstream repo; see `LICENSE.md` there).
- This data is kept in its own folder (`external/fdl-f/`) and tagged with its license in
  every emitted row (`source` field) so the GPL-3.0 provenance is never lost when joined
  into the unified DB.

## What it is

E-Sys "FDL coding cheat" catalog for BMW **F-chassis** vehicles. Each entry maps a
human-readable coding function to the concrete byte/bit write inside a CAFD container:

```
<cafd id="00000794" name="FEM_BODY">
  <code description="Auto Start/Stop Always Off">
    <group id="3023">
      <function start="0" end="0" mask="00010000b">Aktiv</function>
    </group>
  </code>
  ...
</cafd>
```

## Parser / output

- Parser: `parsers/ext_fdl_f.mjs` (zero-dependency Node ESM).
- Output: `build/external/fdl_code.ndjson`
- Schema per row:
  `{ chassis_family, ecu_or_cafd, ecu, cafd, fsw_label, value_label, value_hex, meaning,
     group, byte_start, byte_end, mask, raw_value, series, comment, source }`
- One row per `<function>` write (atomic byte/bit write). Chassis tokens are uppercase;
  hex values are `0x`-prefixed (universal join conventions).

## Retrieval

- Retrieved: 2026-06-24.
- Fetched live from the raw URL above; rows are **fetched**, not reconstructed.
- The commented-out `<!-- Sample Only -->` CAFD block in the source is intentionally excluded.
