# Vendored prebuilt: better-sqlite3

- **Package:** better-sqlite3@11.10.0 (SQLite 3.49.2)
- **File:** better_sqlite3.node
- **Target:** Node ABI 127 (Node 22.x), darwin-arm64
- **sha256:** 56614c9ed32228ef2c498281bb288e0586ba37c81987cdcbce35d4011bd32fe8

## How it was produced

Fetched by `better-sqlite3`'s own `prebuild-install` during a normal
`pnpm install` on the trusted build machine (Node 22, darwin-arm64), then
copied verbatim out of the pnpm store:

    node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node

No source compilation occurred — the binary is the upstream npm/GitHub-Releases
prebuilt published for better-sqlite3@11.10.0. On corp this file is copied into
place by `scripts/vendor-better-sqlite3.mjs` (see package.json `postinstall`),
so corp fetches and compiles nothing for SQLite.

## Re-verify integrity

    shasum -a 256 vendor/better-sqlite3/better_sqlite3.node
