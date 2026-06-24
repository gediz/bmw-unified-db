# Building the database

The database and the BMW-derived source repos are not committed to this repository. The database is too
large for git, and leaving the sources out keeps the BMW-derived data separate from the MIT tooling.
To download a prebuilt copy instead of building, see the [README](../README.md).

## Build it yourself

The build is deterministic: given the same source inputs and Node v22.20.0 (which pins SQLite 3.50.4), it
produces a byte-identical `bmw.sqlite` with the same SHA256, printed at the end so you can compare.

Fetch the source repos at their pinned commits, then build:

```
node fetch-sources.mjs                          # clones the 7 source repos into ./sources
BMW_REPO_ROOT=./sources node --experimental-sqlite build.mjs
```

If the parsers have already written `build/**/*.ndjson`, rebuild just the database and JSON from them:

```
node --experimental-sqlite assemble.mjs
```

Parser scripts are in `parsers/`. The field-by-field schema is in [SCHEMA.md](SCHEMA.md).

## Package a build for release

```
gzip -k -6 dist/bmw.sqlite                      # package -> bmw.sqlite.gz (about 130 MB)
tar -czf json.tar.gz -C dist json               # the JSON mirror, about 13 MB
sha256sum bmw.sqlite bmw.sqlite.gz json.tar.gz > SHA256SUMS
```
