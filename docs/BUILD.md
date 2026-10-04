# Building the database

The database and the BMW-derived source repos are not committed to this repository. The database is too
large for git, and leaving the sources out keeps the BMW-derived data separate from the MIT tooling.
To download a prebuilt copy instead of building, see the [README](../README.md).

## Requirements

- **Node v22.20.0** (the version in `.nvmrc`). Its bundled SQLite 3.50.4 writes its own version into the
  database header, so another Node version builds a correct database with a different hash. `build.mjs`
  refuses to run on another version unless you pass `--any-node`.
- **git 2.35 or newer**, for partial clones and `sparse-checkout --no-cone`.
- **Network** for `fetch-sources.mjs` only, about 1.8 GB. The build itself runs offline.
- **Disk** about 3.5 GB: sources 1.8 GB, `build/` 0.6 GB, `dist/` 0.9 GB.
- **Time** about a minute to fetch on a fast connection, and about a minute to build.

## Build it yourself

```
nvm use                                         # Node v22.20.0, from .nvmrc
node fetch-sources.mjs                          # clone the 8 pinned source repos into ./sources
node --experimental-sqlite build.mjs            # run every parser, assemble dist/bmw.sqlite, check it
```

`fetch-sources.mjs` clones each repo in [`sources.json`](../sources.json) at its pinned commit (a full
40-character SHA) and refuses to continue if a clone is at another commit or has local changes. Large
repos are partial and sparse: only the paths the parsers read are downloaded. The list of ECUs that have
an original BMW binary comes from git metadata, so those binaries (about 1.1 GB) are never downloaded.

`build.mjs` checks that every source is at its pinned commit, clears `build/`, runs each parser in
dependency order (logs in `build/logs/<parser>.log`), assembles `dist/bmw.sqlite` and the JSON mirror,
and writes `dist/SHA256SUMS`. It then checks the result against the committed
[`build-manifest.json`](../build-manifest.json): every table's row count must match, and on the pinned
toolchain the SHA256 must match too. Any mismatch fails the build.

The sources are read from `./sources`, or from `$BMW_REPO_ROOT` if it is set.

Flags:

- `--assemble-only` re-assembles from the existing `build/` output without running the parsers.
- `--any-node` allows another Node version. Row counts are still checked; the hash will differ.
- `--update-manifest` records the result in `build-manifest.json` instead of checking it. Use it only
  after a deliberate change to the data, and commit the new manifest with that change.

Parser scripts are in `parsers/`. The field-by-field schema is in [SCHEMA.md](SCHEMA.md).

## External layers

Two external layers come from committed snapshots, so the build never depends on a live upstream:

- `external/generic-dtc/obd-trouble-codes.csv` for the generic OBD2 codes.
- `external/obdb/obd_signal.ndjson` for the OBDb live-data signals. `node parsers/ext_obdb.mjs --refresh`
  re-fetches them from OBDb's unpinned branches and rewrites the snapshot, which changes the database.

The FDL coding labels come from the pinned `bmw-f` repo. The VIN and standard DID tables are embedded in
their parsers.

## Package a build for release

```
gzip -k -n -6 dist/bmw.sqlite                   # -> dist/bmw.sqlite.gz, about 130 MB (-n: no timestamp)
tar -czf dist/json.tar.gz -C dist json          # the JSON mirror, about 13 MB
(cd dist && sha256sum bmw.sqlite bmw.sqlite.gz json.tar.gz > SHA256SUMS)
```
