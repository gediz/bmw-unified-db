#!/usr/bin/env node
// Zero-dependency fetcher: clones each pinned source repo from sources.json
// into <targetDir>/<name> at its exact commit. Repos with a 'paths' list use a
// sparse checkout so only those paths are downloaded (used for the ~2.5GB
// bmw-advanced-tools repo). Re-running is safe: existing dirs are skipped.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;

function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: 'inherit', ...opts });
}

function main() {
  const manifestPath = join(here, 'sources.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const targetDir = join(here, manifest.targetDir ?? 'sources');
  mkdirSync(targetDir, { recursive: true });

  const repos = manifest.repos ?? [];
  console.log(`Fetching ${repos.length} source repo(s) into ${targetDir}`);

  for (const repo of repos) {
    const { name, url, commit, paths } = repo;
    const dir = join(targetDir, name);

    if (existsSync(dir)) {
      console.log(`\n[skip] ${name} already exists at ${dir}`);
      continue;
    }

    const sparse = Array.isArray(paths) && paths.length > 0;
    console.log(`\n[clone] ${name} <- ${url} @ ${commit}${sparse ? ' (sparse)' : ''}`);

    // Blobless, no-checkout clone keeps the initial download minimal; blobs are
    // fetched lazily on checkout (only for the paths we keep when sparse).
    git(['clone', '--filter=blob:none', '--no-checkout', url, dir]);

    if (sparse) {
      git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...paths]);
    }

    git(['-C', dir, 'checkout', commit]);
    console.log(`[done]  ${name}`);
  }

  console.log('\ndone; now run: BMW_REPO_ROOT=./sources node --experimental-sqlite build.mjs');
}

main();
