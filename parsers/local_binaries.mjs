#!/usr/bin/env node
// BMW Unified DB — meta: which ECUs have an original EDIABAS binary in bmw-advanced-tools.
// Writes build/meta/local_binaries.txt (one lowercased SGBD name per line), read by assemble.mjs
// to set ecu_variant.has_local_binary (the ECUs whose decode was cross-checked against BMW's binary).
//
// Rule: the basenames of the top-level *.prg files in bmw-advanced-tools/app/EDIABAS/ECU, extension
// stripped, lowercased, de-duplicated, sorted. Only file NAMES are needed, so they are read with
// `git ls-tree` from the checked-out commit; the ~1.1 GB of binaries never has to be downloaded.
// Falls back to a directory listing only when the source is not a git checkout; that needs a FULL copy of
// app/EDIABAS/ECU, because the sparse checkout from fetch-sources.mjs omits the *.prg files.

import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.BMW_REPO_ROOT ? path.resolve(process.env.BMW_REPO_ROOT) : path.resolve(import.meta.dirname, '..', '..');
const TOOLS = path.join(ROOT, 'bmw-advanced-tools');
const OUT_DIR = path.resolve(import.meta.dirname, '..', 'build', 'meta');
const OUT_FILE = path.join(OUT_DIR, 'local_binaries.txt');

function listNames() {
  if (existsSync(path.join(TOOLS, '.git'))) {
    const out = execFileSync('git', ['-C', TOOLS, 'ls-tree', '--name-only', 'HEAD', 'app/EDIABAS/ECU/'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    return out.split('\n').filter(Boolean).map(p => path.posix.basename(p));
  }
  const dir = path.join(TOOLS, 'app', 'EDIABAS', 'ECU');
  if (!existsSync(dir)) { console.error('local_binaries: missing ' + dir); process.exit(1); }
  return readdirSync(dir);
}

const names = [...new Set(listNames().filter(n => /\.prg$/i.test(n)).map(n => n.slice(0, -4).toLowerCase()))].sort();
if (names.length === 0) { console.error('local_binaries: no *.prg found under ' + TOOLS); process.exit(1); }
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, names.join('\n') + '\n');
console.error(`local_binaries: ${names.length} ECUs -> ${OUT_FILE}`);
