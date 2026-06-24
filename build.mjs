#!/usr/bin/env node --experimental-sqlite
// One-command build. Runs the deterministic assembly and prints the SHA256 of the result.
//
//   node --experimental-sqlite build.mjs
//
// Determinism: given the same build/*.ndjson inputs and Node v22.x (which pins the SQLite version),
// this produces a byte-identical dist/bmw.sqlite with the same SHA256. The hash is written to
// dist/SHA256SUMS and printed below; publish it with the Release so downloads can be verified.
//
// To regenerate build/*.ndjson from source first, run the parsers (they read the sibling BMW repos;
// set BMW_REPO_ROOT to point at the collection root if it is not at the default path). The external
// layers under build/external/ are pinned snapshots; the ext_*.mjs parsers refresh them from upstream.
import { createHash } from 'node:crypto'
import { createReadStream, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = import.meta.dirname
const dbPath = path.join(ROOT, 'dist', 'bmw.sqlite')

console.log('Assembling dist/bmw.sqlite (deterministic) ...')
await import('./assemble.mjs')   // runs in this --experimental-sqlite process

if (!existsSync(dbPath)) { console.error('build failed: dist/bmw.sqlite not produced'); process.exit(1) }

const hash = await new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(dbPath).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
})
writeFileSync(path.join(ROOT, 'dist', 'SHA256SUMS'), `${hash}  bmw.sqlite\n`)
console.log(`\nbuild complete.\nSHA256(bmw.sqlite) = ${hash}\nWrote dist/SHA256SUMS. Publish this hash with the Release so downloads can be verified.`)
