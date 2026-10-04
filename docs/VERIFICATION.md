# Verification

Verification here means the database reproduces these source repos faithfully. It does not mean the data
is current or correct for any specific car. Every layer was reconciled against its source at full census,
not by sampling. The coverage gaps this verification does not close are in [COVERAGE.md](COVERAGE.md).

- Diagnostics: job counts, table counts, job and table name sets, per-job argument and result counts, and
  per-table dimensions match across all 2,466 files with zero mismatches. Of 326,161 fault rows, all but
  two matched on the first pass; the two were a parser bug (a capital `0X` hex prefix) and are fixed.
- Markdown against BMW binaries: on a full census of 1,805 ECUs that have a local binary, the decode is
  faithful. Zero fabricated codes, zero omissions on the same-version cohort. The other 661 decoded ECUs,
  the G-series among them, have no local binary and are unverifiable this way.
- CAN, coding, routing, DS2: zero mismatches against the DBC, the TRC files, `T_GRTB.PRG`, and the MS43
  sources.
