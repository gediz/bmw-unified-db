#!/usr/bin/env -S node --experimental-sqlite
// One-command build: verifies the pinned sources, runs every parser, assembles dist/bmw.sqlite, and
// checks the result against the committed build-manifest.json.
//
//   node fetch-sources.mjs                    # clone the pinned source repos into ./sources
//   node --experimental-sqlite build.mjs      # parsers -> build/*.ndjson -> dist/bmw.sqlite
//
// Flags:
//   --assemble-only     skip the parsers and re-assemble the existing build/ output
//   --any-node          allow a Node version other than .nvmrc (the hash will then differ; row counts
//                       are still checked)
//   --update-manifest   write the result to build-manifest.json instead of checking against it
//
// Source root: $BMW_REPO_ROOT if set, else ./sources (filled by fetch-sources.mjs). Every repo in
// sources.json must be present there at its pinned commit.
//
// Determinism: with the pinned sources and the Node version in .nvmrc (its bundled SQLite writes its own
// version into the file header), the build is byte-identical; build-manifest.json holds the expected
// SHA256 and per-table row counts.
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { createReadStream, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

const ROOT = import.meta.dirname
const dbPath = path.join(ROOT, 'dist', 'bmw.sqlite')
const manifestPath = path.join(ROOT, 'build-manifest.json')
const has = (f) => process.argv.includes(f)
const assembleOnly = has('--assemble-only'), anyNode = has('--any-node'), updateManifest = has('--update-manifest')
const fail = (msg) => { console.error('build failed: ' + msg); process.exit(1) }

// Parser run order. sgbd before english/winkfp (they read build/sgbd/ecu_variant.ndjson for stats);
// routing before topology (topology reads build/routing/routing.ndjson). cafd.mjs is a bring-your-own
// tool for a user-supplied CAFD export and is not part of the default build.
const PARSERS = [
  'local_binaries', 'sgbd', 'routing', 'topology', 'english', 'winkfp', 'applicability', 'coding',
  'cvt', 'checksum_netto', 'can', 'ds2', 'measurement', 'translations',
  'ext_vin', 'ext_uds_did', 'ext_generic_dtc', 'ext_fdl_f', 'ext_obdb',
]

// Every file assemble.mjs reads. A parser that writes nothing is caught here; a parser that writes too
// little is caught by the per-table row counts in build-manifest.json.
const EXPECTED = [
  'meta/local_binaries.txt',
  'sgbd/ecu_variant.ndjson', 'sgbd/job.ndjson', 'sgbd/uds_services.ndjson', 'sgbd/job_arg.ndjson',
  'sgbd/job_result.ndjson', 'sgbd/ecu_table.ndjson', 'sgbd/table_row.ndjson', 'sgbd/dtc.ndjson',
  'routing/routing.ndjson', 'topology/ecu_bus.ndjson',
  'english/english_dtc.ndjson', 'english/english_job.ndjson',
  'flash/ecu_hwnr.ndjson', 'flash/flash_map.ndjson',
  'applicability/vehicle_ecu.ndjson', 'applicability/option_code.ndjson',
  'coding/coding_label.ndjson', 'coding/coding_example.ndjson', 'coding/coding_variant.ndjson', 'coding/coding_netto.ndjson',
  'can/can_message.ndjson', 'can/can_signal.ndjson', 'can/can_value.ndjson', 'can/can_checksum_algo.ndjson',
  'ds2/ds2_job.ndjson', 'ds2/ds2_fault.ndjson',
  'measurement/measurement.ndjson', 'translation/translation.ndjson',
  'external/vin_wmi.ndjson', 'external/vin_position.ndjson', 'external/uds_did_standard.ndjson',
  'external/generic_dtc.ndjson', 'external/fdl_code.ndjson', 'external/obd_signal.ndjson',
]

// ---- toolchain ----
const wantNode = readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim()
const toolchain = { node: process.version, sqlite: process.versions.sqlite }
if (process.version !== wantNode) {
  if (!anyNode) fail(`Node ${wantNode} is required for a byte-identical build (running ${process.version}). Use it (e.g. nvm use) or pass --any-node.`)
  console.warn(`WARNING: Node ${process.version} (SQLite ${process.versions.sqlite}) instead of ${wantNode}: the hash will differ; row counts are still checked.`)
}

// ---- parsers ----
if (!assembleOnly) {
  const src = process.env.BMW_REPO_ROOT ? path.resolve(process.env.BMW_REPO_ROOT) : path.join(ROOT, 'sources')
  if (!existsSync(src)) fail(`no sources at ${src}. Run: node fetch-sources.mjs`)
  console.log(`Source root: ${src}`)
  const pins = JSON.parse(readFileSync(path.join(ROOT, 'sources.json'), 'utf8')).repos
  for (const { name, commit } of pins) {
    let at = ''
    try { at = execFileSync('git', ['-C', path.join(src, name), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
    if (at !== commit) fail(`${name} at ${src} is ${at || 'missing'}, expected ${commit}. Run: node fetch-sources.mjs`)
  }
  console.log(`  all ${pins.length} sources at their pinned commits`)

  rmSync(path.join(ROOT, 'build'), { recursive: true, force: true })   // no stale output can pass the checks
  const logDir = path.join(ROOT, 'build', 'logs')
  mkdirSync(logDir, { recursive: true })
  for (const name of PARSERS) {
    const t0 = performance.now()
    const r = spawnSync(process.execPath, [path.join(ROOT, 'parsers', name + '.mjs')], {
      cwd: ROOT, env: { ...process.env, BMW_REPO_ROOT: src },
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 << 20, encoding: 'utf8',
    })
    writeFileSync(path.join(logDir, name + '.log'),
      `--- stdout\n${r.stdout || ''}\n--- stderr\n${r.stderr || ''}${r.error ? '\n' + r.error.message : ''}`)
    if (r.status !== 0) fail(`parser ${name} exited ${r.status}. See build/logs/${name}.log`)
    console.log(`  ${name.padEnd(16)} ok  ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  }
}

const missing = EXPECTED.filter(f => { const p = path.join(ROOT, 'build', f); return !existsSync(p) || statSync(p).size === 0 })
if (missing.length) fail('missing or empty parser output:\n  ' + missing.join('\n  '))

// ---- assemble ----
console.log('Assembling dist/bmw.sqlite (deterministic) ...')
await import('./assemble.mjs')   // runs in this --experimental-sqlite process
if (!existsSync(dbPath)) fail('dist/bmw.sqlite not produced')

const sha256 = await new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(dbPath).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
})
writeFileSync(path.join(ROOT, 'dist', 'SHA256SUMS'), `${sha256}  bmw.sqlite\n`)

const db = new DatabaseSync(dbPath, { readOnly: true })
const tables = Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'search_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c]))
db.close()
const result = { ...toolchain, sha256, tables }

// ---- check against the committed manifest ----
if (updateManifest) {
  writeFileSync(manifestPath, JSON.stringify(result, null, 2) + '\n')
  console.log(`\nWrote build-manifest.json\nSHA256(bmw.sqlite) = ${sha256}`)
} else if (!existsSync(manifestPath)) {
  console.warn('\nNo build-manifest.json to check against (create one with --update-manifest).')
  console.log(`SHA256(bmw.sqlite) = ${sha256}`)
} else {
  const want = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const diffs = [...new Set([...Object.keys(want.tables), ...Object.keys(tables)])]
    .filter(t => want.tables[t] !== tables[t]).map(t => `${t}: expected ${want.tables[t] ?? '-'} rows, got ${tables[t] ?? '-'}`)
  if (diffs.length) fail('row counts differ from build-manifest.json:\n  ' + diffs.join('\n  '))
  const sameToolchain = want.node === toolchain.node && want.sqlite === toolchain.sqlite
  console.log(`\nbuild complete. Row counts match build-manifest.json (${Object.keys(tables).length} tables).`)
  console.log(`SHA256(bmw.sqlite) = ${sha256}`)
  if (sha256 === want.sha256) console.log('Byte-identical to build-manifest.json.')
  else if (sameToolchain) fail(`hash differs from build-manifest.json (${want.sha256}) on the same toolchain`)
  else console.log(`Hash differs from build-manifest.json because the toolchain differs (${want.node}/SQLite ${want.sqlite} expected).`)
}
