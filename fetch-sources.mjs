#!/usr/bin/env node
// Zero-dependency fetcher: clones each pinned source repo from sources.json into <targetDir>/<name> at
// its exact commit. Repos with a 'paths' list use a sparse checkout so only those paths are downloaded
// (bmw-advanced-tools is ~2.5GB upstream, openpilot ~1.2GB). Clones are blob-less, so git metadata such
// as file names (used for build/meta/local_binaries.txt) is available without downloading file contents.
// Pins are full 40-character commit SHAs and are checked exactly. Re-running is safe: an existing clone
// is reused only if HEAD equals the pin and its working tree is unmodified; its sparse paths are re-applied
// so edits to sources.json take effect. Anything else exits with an error rather than build from wrong data.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;

function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: 'inherit', ...opts });
}
function head(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function main() {
  const manifest = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'));
  const targetDir = join(here, manifest.targetDir ?? 'sources');
  mkdirSync(targetDir, { recursive: true });

  const repos = manifest.repos ?? [];
  console.log(`Fetching ${repos.length} source repo(s) into ${targetDir}`);

  let bad = 0;
  for (const { name, url, commit, paths } of repos) {
    const dir = join(targetDir, name);
    const sparse = Array.isArray(paths) && paths.length > 0;

    if (!/^[0-9a-f]{40}$/.test(commit)) { console.error(`[FAIL] ${name}: pin must be a full 40-char SHA, got ${commit}`); bad++; continue; }

    const fresh = !existsSync(dir);
    if (fresh) {
      console.log(`\n[clone] ${name} <- ${url} @ ${commit.slice(0, 12)}${sparse ? ' (sparse)' : ''}`);
      // Blob-less, no-checkout clone: trees and commits only; blobs are fetched lazily on checkout,
      // and only for the paths kept when sparse.
      git(['clone', '--filter=blob:none', '--no-checkout', url, dir]);
    }
    if (sparse) git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...paths]);
    else if (existsSync(join(dir, '.git', 'info', 'sparse-checkout'))) git(['-C', dir, 'sparse-checkout', 'disable']);
    if (fresh || head(dir) !== commit) git(['-C', dir, 'checkout', '--quiet', commit]);

    const at = head(dir);
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (at !== commit) {
      console.error(`[FAIL] ${name} is at ${at}, expected ${commit}. Delete ${dir} and re-run.`);
      bad++;
    } else if (dirty) {
      console.error(`[FAIL] ${name} has local modifications. Delete ${dir} and re-run.`);
      bad++;
    } else {
      console.log(`[ok]    ${name} @ ${at.slice(0, 12)}`);
    }
  }

  if (bad) process.exit(1);
  console.log('\nAll sources at their pinned commits. Next: node --experimental-sqlite build.mjs');
}

main();
