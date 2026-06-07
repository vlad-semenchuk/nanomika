#!/usr/bin/env node
// Auditable, dependency-free postinstall: copy the vendored better-sqlite3
// prebuilt into the pnpm store so the package loads without compiling or
// fetching anything. Runs after every install (incl. `pnpm install --prod`).
//
// No-ops cleanly when better-sqlite3 isn't installed (e.g. a docs-only checkout).
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'vendor', 'better-sqlite3', 'better_sqlite3.node');
const destDir = join(
  root,
  'node_modules',
  '.pnpm',
  'better-sqlite3@11.10.0',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
);
const dest = join(destDir, 'better_sqlite3.node');

if (!existsSync(src)) {
  console.error(`[vendor-better-sqlite3] missing vendored binary: ${src}`);
  process.exit(1);
}
if (!existsSync(join(root, 'node_modules', '.pnpm', 'better-sqlite3@11.10.0'))) {
  console.log('[vendor-better-sqlite3] better-sqlite3 not installed; skipping');
  process.exit(0);
}
if (existsSync(dest)) {
  console.log('[vendor-better-sqlite3] binary already present; skipping');
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[vendor-better-sqlite3] installed prebuilt -> ${dest}`);
