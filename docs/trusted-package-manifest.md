# Trusted Package Manifest

> Auditable list of every pinned package + version in the corp install path.
> Regenerate with `node scripts/gen-trusted-manifest.mjs > docs/trusted-package-manifest.md`.

## Host production dependencies (npm registry)

| Package | Range (package.json) |
|---|---|
| @chat-adapter/slack | 4.27.0 |
| @clack/core | ^1.2.0 |
| @clack/prompts | ^1.2.0 |
| better-sqlite3 | 11.10.0 |
| chat | ^4.27.0 |
| cron-parser | 5.5.0 |
| kleur | ^4.1.5 |

Exact resolved versions are pinned in `pnpm-lock.yaml` and installed with
`pnpm install --prod --frozen-lockfile` under `minimumReleaseAge: 4320`.

## Vendored native binary (no compile, no fetch on corp)

| File | Target | sha256 |
|---|---|---|
| vendor/better-sqlite3/better_sqlite3.node | better-sqlite3@11.10.0, Node ABI 127 darwin-arm64 | 56614c9ed32228ef2c498281bb288e0586ba37c81987cdcbce35d4011bd32fe8 |

## Container image (built here, `docker load`ed on corp)

```
FROM node:22-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732
ARG CLAUDE_CODE_VERSION=2.1.128
ARG AGENT_BROWSER_VERSION=latest
ARG BUN_VERSION=1.3.12
ARG GMAIL_MCP_VERSION=1.1.11
ARG CALENDAR_MCP_VERSION=2.6.1
ARG PNPM_VERSION=10.33.0
```

