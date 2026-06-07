#!/usr/bin/env node
// Emit the auditable trusted-package manifest for corp security review:
//   - host production dependencies (resolved versions from the lockfile)
//   - the vendored native binary (name/version/sha256)
//   - the container image's pinned global installs + base-image digest
// Pure Node, no deps. Run: node scripts/gen-trusted-manifest.mjs > docs/trusted-package-manifest.md
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const prodDeps = Object.entries(pkg.dependencies ?? {}).sort();

function sha256(path) {
  return existsSync(path)
    ? execSync(`shasum -a 256 ${path}`).toString().split(/\s+/)[0]
    : 'MISSING';
}

// Container image: pull the pinned ARG/FROM lines straight from the Dockerfile.
const dockerfile = readFileSync('container/Dockerfile', 'utf8');
const pins = dockerfile
  .split('\n')
  .filter((l) => /^FROM |^ARG \w+_VERSION=/.test(l.trim()))
  .map((l) => l.trim());

const out = [];
out.push('# Trusted Package Manifest');
out.push('');
out.push('> Auditable list of every pinned package + version in the corp install path.');
out.push('> Regenerate with `node scripts/gen-trusted-manifest.mjs > docs/trusted-package-manifest.md`.');
out.push('');
out.push('## Host production dependencies (npm registry)');
out.push('');
out.push('| Package | Range (package.json) |');
out.push('|---|---|');
for (const [name, range] of prodDeps) out.push(`| ${name} | ${range} |`);
out.push('');
out.push('Exact resolved versions are pinned in `pnpm-lock.yaml` and installed with');
out.push('`pnpm install --prod --frozen-lockfile` under `minimumReleaseAge: 4320`.');
out.push('');
out.push('## Vendored native binary (no compile, no fetch on corp)');
out.push('');
out.push('| File | Target | sha256 |');
out.push('|---|---|---|');
out.push(
  `| vendor/better-sqlite3/better_sqlite3.node | better-sqlite3@11.10.0, Node ABI 127 darwin-arm64 | ${sha256('vendor/better-sqlite3/better_sqlite3.node')} |`,
);
out.push('');
out.push('## Container image (built here, `docker load`ed on corp)');
out.push('');
out.push('```');
for (const p of pins) out.push(p);
out.push('```');
out.push('');
console.log(out.join('\n'));
