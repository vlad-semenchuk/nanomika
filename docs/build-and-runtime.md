# Build & Runtime

NanoMika runs a split stack: the host is Node + pnpm, the agent container is Bun. They communicate exclusively through two SQLite files per session — there are no shared modules between them, which is what lets them use different runtimes cleanly.

## Why the split

- **Host stays on Node** (22.x, per `engines` in `package.json`) because it depends on `better-sqlite3`, a native Node addon, and the Chat SDK channel adapters. Bun's Node-API compat has improved, but this isn't where we want risk.
- **Container runs Bun** because `bun:sqlite` is built-in (no native compile of `better-sqlite3` per image rebuild), source runs directly (no tsc build step at image build or session wake), and `bun install` is ~5-10× faster than `npm install`.

Host and container each have their own package tree:

```
/                             pnpm + Node 22
  pnpm-lock.yaml              host deps (Chat SDK + Slack adapter, better-sqlite3, cron-parser, etc.)
  pnpm-workspace.yaml         minimumReleaseAge + onlyBuiltDependencies policy

/container/agent-runner/      Bun 1.3+
  bun.lock                    agent-runner runtime deps (Claude Agent SDK, MCP SDK, zod, etc.)
  package.json                @types/bun, typescript devDeps for type-checking
```

The container image also has pnpm + Node inside for global CLIs (`@anthropic-ai/claude-code`, `agent-browser`). Those are Node binaries the agent invokes at runtime, not library deps. Keeping them on pnpm preserves the supply-chain policy for CLI versions.

## Lockfiles

| Tree | Lockfile | Manager | Regenerate after dep change |
|------|----------|---------|----------------------------|
| Host | `pnpm-lock.yaml` | pnpm 10 | `pnpm install` |
| Agent-runner | `container/agent-runner/bun.lock` | Bun 1.3+ | `cd container/agent-runner && bun install` |

Both are committed. CI installs both with `--frozen-lockfile`, and the Dockerfile runs `bun install --frozen-lockfile` — any drift between `package.json` and lockfile fails the build.

## Supply chain

- **Host** (pnpm): `minimumReleaseAge: 4320` (3-day hold on new versions), `onlyBuiltDependencies` allowlist for postinstall scripts (`better-sqlite3`, `esbuild` — `better-sqlite3` builds its native binding on `pnpm install`). See `pnpm-workspace.yaml` and `docs/SECURITY.md`.
- **Global CLIs in the image** (pnpm): exact versions via Dockerfile ARGs plus an `only-built-dependencies` allowlist (`agent-browser`, `@anthropic-ai/claude-code`) written to `/root/.npmrc` in the Dockerfile.
- **Agent-runner** (Bun): no release-age policy — Bun doesn't have an equivalent today. The defenses are `bun.lock` pinning plus version-pinned CLIs/Bun itself via Dockerfile ARGs. When bumping `@anthropic-ai/claude-agent-sdk` or any runtime dep, review the release date on npm and bump deliberately, not via `bun update`.

## Image build surface

`container/Dockerfile` is a single-stage build on `node:22-slim`. Build it with `pnpm run build:image` (runs `container/build.sh`), which tags it `nanomika-agent-v2-<first 8 hex chars of sha1(checkout path)>:latest` — the same name `src/install-slug.ts` computes for the host and spawns (`CONTAINER_IMAGE_BASE` overrides the name in `build.sh`; the host spawns `CONTAINER_IMAGE` instead when that is set).

- **Pinned ARGs** — `BUN_VERSION`, `CLAUDE_CODE_VERSION`, `PNPM_VERSION`, `AGENT_BROWSER_VERSION`. The base image is pinned by digest. Bump deliberately in PRs.
- **CJK fonts** — `ARG INSTALL_CJK_FONTS=false`. `container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through. Default build saves ~200MB; opt in when the user works with Chinese/Japanese/Korean content.
- **BuildKit cache mounts** — `/var/cache/apt`, `/var/lib/apt`, `/root/.bun/install/cache`, `/root/.cache/pnpm`. Rebuilds where `package.json`/`bun.lock` haven't changed are fast. Requires BuildKit (default on Docker 23+).
- **`tini` as init** — reaps Chromium zombies, forwards signals so in-flight `outbound.db` writes finalize on SIGTERM.
- **`entrypoint.sh`** (extracted) — `exec bun run /app/src/index.ts` under tini. Readable and diffable.
- **No compiled `/app/dist`** — Bun runs TS directly. The host also mounts fresh source over `/app/src` at session start, so host edits take effect without rebuilding the image.

## Session wake (two paths)

1. **Base image ENTRYPOINT** — used only when the image is run directly (e.g. a manual `docker run -i` with JSON on stdin): `tini --> entrypoint.sh` captures stdin to `/tmp/input.json`, then `exec bun run /app/src/index.ts`.
2. **Host-spawned session** — `src/container-runner.ts` (line ~440) uses `--entrypoint bash` with `-c 'exec bun run /app/src/index.ts'`. Bypasses tini (Docker's default PID 1 handling applies). Stdin is unused; all IO flows through the mounted session DBs.

Both paths end with Bun running the same source file from `/app/src/index.ts`.

## CI shape

`.github/workflows/ci.yml` runs on pull requests to `main`. It installs pnpm, Node 22 (with pnpm cache) and Bun 1.3.12, then runs in order:

1. `pnpm install --frozen-lockfile` (host)
2. `bun install --frozen-lockfile` in `container/agent-runner/` (container)
3. `pnpm run format:check`
4. `pnpm run lint`
5. `pnpm exec tsc --noEmit` (host typecheck)
6. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (container typecheck)
7. `pnpm exec vitest run` (host tests)
8. `bun test` in `container/agent-runner/` (container tests)

Any failure fails the PR.

## Key invariants

- **Session DBs must use `journal_mode=DELETE`.** WAL's `-shm` memory-map doesn't cross VirtioFS between host and guest. See the doc comment at the top of `container/agent-runner/src/db/connection.ts` and `src/session-manager.ts`.
- **Named SQL parameters in the container require the prefix in JS object keys.** `bun:sqlite` does not auto-strip `@`/`$`/`:` the way `better-sqlite3` does on the host. Use `$name` in both SQL and keys: `.run({ $id: msg.id })`. Positional `?` params work normally.
- **Agent-runner tests run under `bun:test`, not vitest.** `vitest.config.ts` only includes `*.test.ts` files under `src/` and the top-level scripts directory (e.g. `scripts/q.test.ts`), so the `container/agent-runner/` tree is never picked up — vitest runs on Node and can't load `bun:sqlite`.
- **No tsc build step in the container image.** Adding one would put a compile step back on every session wake.
- **Global container CLIs stay on pnpm, not Bun.** `agent-browser`, `@anthropic-ai/claude-code` and any future Node CLIs the agent invokes should be pinned versions under the Dockerfile's pnpm global-install block. `bun install -g` would bypass the pnpm `only-built-dependencies` allowlist.

