# NanoMika — Corp-Laptop Trusted-Install Hardening

**Date:** 2026-06-07
**Status:** Approved — ready for implementation (Phase 0). Not yet implemented.
**Author:** Vlad Semenchuk

## Goal

Produce a NanoMika tree that installs and runs on a **locked-down corporate laptop**
pulling **only trusted, pinned packages from the default npm registry** — with
**no install-time arbitrary code execution** (no `curl | sh`, no source compilation,
no GitHub-branch fetches). The install must be **auditable**: a reviewable list of
every package + version that corp security can sign off on.

Capabilities to keep: **Slack (two-way), Gmail (tool), Google Calendar (tool)**.
Everything else is removed to minimize the trusted surface.

## Trust criteria (all four apply)

1. **Pinned + soak period** — exact versions, no ranges; npm packages honor the
   existing `minimumReleaseAge: 4320` (3-day) gate. Lockfile is the source of truth.
2. **No install-time code exec** — no `curl | sh`, no compiling from source, no
   postinstall scripts running arbitrary third-party code. Prebuilt / pure-JS only.
3. **Auditable manifest** — a reviewable list of every package + version (host +
   container) that corp signs off on before install.
4. **Approved registry only** — everything from the public npm registry (default).
   No GitHub-branch fetches, no remote installers.

## Evidence: what the corp policy actually permits

The reference project `github.com/vlad-semenchuk/claude-mem` was successfully
downloaded, installed, and run on the corp laptop. Its install model tells us the
real tolerance:

| Observation in claude-mem | Implication |
|---|---|
| Installs via `npx`/Bun from the **default npm registry** | Registry installs are allowed; no corp mirror needed |
| Runtime deps are pure-JS + **npm-distributed prebuilt** native packages (sharp, ripgrep, fsevents) | Prebuilt `.node` from npm = allowed; **nothing compiles at install** |
| Uses **`bun:sqlite`** — no `better-sqlite3`, no node-gyp | The native-SQLite problem can be dodged entirely on Bun |
| `tree-sitter-*` compilers are **dev-only** | The corp end-user never compiles — compilation is *unproven*, just never needed |
| `node_modules` + `bun.lock` are **gitignored** | Confirms "no need to vendor node_modules"; registry install is trusted |

**Conclusion:** corp permits *npm-registry installs of pinned, prebuilt,
pure-JS-or-npm-prebuilt packages*. It does **not** require air-gapping. The only
gray areas NanoMika must avoid are (a) downloading a prebuilt from **GitHub
Releases** and (b) **compiling** from source — neither of which claude-mem ever did.

## Scope decision: single sub-project

Gmail stays a **tool** (the existing `add-gmail-tool` MCP server), **not** a new
inbound channel. (A Gmail polling channel does not exist upstream and would be a
from-scratch build; explicitly out of scope.) This keeps the work to one
sub-project: *trusted-install hardening*.

## Inventory

### Keep — vendor into the tree now, on this trusted machine

| Item | Source | Form |
|---|---|---|
| Slack adapter (two-way) | `nanocoai/channels` branch → commit into `src/channels/slack.ts` + setup files | npm `@chat-adapter/*`, pinned |
| Gmail tool | already in tree (`add-gmail-tool`) — **rewire to native Google OAuth** | container MCP `@gongrzhe/server-gmail-autoauth-mcp@1.1.11` |
| Google Calendar tool | already in tree (`add-gcal-tool`) — **rewire to native Google OAuth** | container MCP, pinned |
| Credential proxy (Anthropic) | already implemented (`src/credential-proxy.ts`) | host-side, reads `.env` |
| Core host + agent-runner + scheduling/approvals/permissions | already in tree | — |

### Remove

- **OneCLI (finish removal):** `setup/onecli.ts`, OneCLI logic in `setup/auto.ts`,
  `setup/auth.ts`, `setup/lib/setup-config.ts`, `setup/index.ts` (the `onecli` step
  registration), the `init-onecli` skill, the `onecli-gateway` container skill, and
  remaining comment references. (Runtime wiring already removed — see "Current state".)
- **All other channels** (skills + any vendored code): discord, telegram, whatsapp,
  whatsapp-cloud, teams, linear, github, imessage, webex, **resend**, matrix, gchat,
  signal, deltachat, wechat, emacs.
- **Providers:** `add-opencode`, `add-ollama-provider`, `add-codex` skills.
- **Misc skills:** dashboard, karpathy-llm-wiki, macos-statusbar, mnemon, parallel,
  rtk, vercel, atomic-chat-tool, ollama-tool, get-qodo-rules, qodo-pr-resolver,
  x-integration.
- **Container skills:** `vercel-cli`, `whatsapp-formatting`, `frontend-engineer`
  (keep `welcome`, `self-customize`, `agent-browser`, `slack-formatting`).
- **Dockerfile:** strip global installs for removed tools (vercel, etc.).

## Architecture & decisions

### 1. Runtime pin (host)

- **Node 22 LTS** (`.nvmrc` = `22`, `package.json` `engines.node` = `"22.x"`).
  ABI 127; matches the container's `node:22`.
- Rationale: Node 24 (the machine default) has **no** `better-sqlite3` prebuilt and
  compiles from source — forbidden. Node 22 has a verified working prebuilt.
- *Verified empirically:* Node 22 (ABI 127, darwin-arm64) loads
  `better-sqlite3@11.10.0` (SQLite 3.49.2) from a prebuilt — no compile.

### 2. SQLite native dependency — vendor the prebuilt

Stay on Node + `better-sqlite3` (porting the host's **45 files / 429 call sites** to
`bun:sqlite` + a Node→Bun toolchain migration is a separate, larger project and is
out of scope).

Make the `better-sqlite3` install corp-clean:

1. **Remove `better-sqlite3` from `onlyBuiltDependencies`** so pnpm never runs its
   `prebuild-install || node-gyp rebuild` install script on corp (no GitHub fetch,
   no compile fallback).
2. **Vendor the pinned prebuilt** `better_sqlite3.node` (v11.10.0 / node-v127 /
   darwin-arm64) into the repo under `vendor/better-sqlite3/`, with documented
   provenance (sha256 + how it was produced).
3. A small **root postinstall** (our own, pinned, auditable code) copies the vendored
   `.node` into
   `node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/`.

Net: corp install fetches nothing for SQLite and compiles nothing.

### 3. Ship built `dist/` + prod-only install

- **Build `dist/` on this trusted machine**; ship it to corp (transfer artifact,
  not committed). Corp runs `node dist/index.js` via the service.
- Corp dependency install: **`pnpm install --prod --frozen-lockfile`** — pulls only
  runtime deps (`better-sqlite3` [script-skipped, binary vendored], `chat`,
  `@clack/core`, `@clack/prompts`, `cron-parser`, `kleur`, + the Slack adapter pkg).
  All pure-JS except `better-sqlite3`.
- Dev-only heavy packages (`tsx`, `vitest`, `esbuild`, `typescript`, `eslint`,
  `prettier`) are **never installed on corp**.
- Confirm during implementation that `tsc` emits `setup/` too, so corp can run setup
  via `node dist/setup/index.js` without `tsx`.
- **Drop stale `onlyBuiltDependencies`** entries `protobufjs` and `sharp` (no longer
  in the graph). Keep `minimumReleaseAge: 4320`. Mandate `--frozen-lockfile` on corp.

### 4. Credentials (no OneCLI)

All real creds live locally on the encrypted corp disk; none in chat, container env
vars, or the image.

| Credential | Path to the agent | Stored in |
|---|---|---|
| **Anthropic** (API key *or* OAuth token) | host credential proxy reads `.env`, injects on requests to `host.docker.internal:3001`; container holds a placeholder | `.env` (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) |
| **Slack** (bot/app tokens) | Slack adapter runs host-side, reads from `.env` | `.env` (`SLACK_BOT_TOKEN` + app/signing vars — exact set confirmed when vendoring) |
| **Google** (Gmail + Calendar) | `autoauth` MCP runs in-container, reads real OAuth creds from a mounted dir | `~/.gmail-mcp/` (real `gcp-oauth.keys.json` + `credentials.json`), mounted read-only via `allowedRoots` |

**One-time Google step on corp (user-performed):** create a Google Cloud OAuth
*Desktop* client, drop `gcp-oauth.keys.json` in `~/.gmail-mcp/`, run the autoauth flow
once (browser sign-in) to mint `credentials.json`. Calendar reuses the same Google
client/scopes. Thereafter the agent runs headless.

### 5. Container image — build here, load on corp

- **Build on this trusted machine**, then
  `docker save nanomika-agent:latest | gzip > nanomika-agent-<ver>.tar.gz`, transfer,
  `docker load` on corp. Corp pulls **zero** external code for the image.
- **Runtime = Colima** (Docker-API compatible; no Docker Desktop licensing). `docker
  save`/`load` and NanoMika's Docker runtime path both work unchanged against Colima's
  socket. Confirm `DOCKER_HOST`/socket wiring during setup.
- **Dockerfile slimmed + fully pinned:** keep `node:22` base **by digest**, plus
  `bun`, `claude-code`, `agent-browser`, `gmail-mcp@1.1.11`, `gcal-mcp@<pin>`; remove
  vercel and other dropped tools. Every `ARG` an exact version.
- Image is a **transfer artifact**, not committed to git.

## Current state (already done, uncommitted on `main`)

OneCLI removed from the **runtime** and replaced by the credential proxy:

- New: `src/credential-proxy.ts` (+ test). Wired into `src/index.ts`
  (startup/shutdown) and `src/container-runner.ts` (`ANTHROPIC_BASE_URL` → proxy +
  placeholder token).
- Removed: `@onecli-sh/sdk` dep, `src/modules/approvals/onecli-approvals.ts`,
  `ONECLI_URL`/`ONECLI_API_KEY` config, OneCLI approval-handler wiring.
- Remaining `onecli` references in `src/`/`container/` are **comments only**
  (no functional code). Functional OneCLI code remains only in the **setup flow**
  (Phase 1 below).
- Verified: typecheck ✅, build ✅, target tests ✅ (on Node 22).

## Implementation phases

**Phase 0 — Land the runtime OneCLI removal.** Commit the already-done credential-proxy
change to a branch; push. (Commit author: Vlad only, no Claude co-author.)

**Phase 1 — Finish OneCLI removal (setup flow).** Delete `setup/onecli.ts`; remove
OneCLI from `setup/auto.ts`, `setup/auth.ts`, `setup/lib/setup-config.ts`,
`setup/index.ts`; remove `init-onecli` skill + `onecli-gateway` container skill; clean
comments. Verify `/setup` runs with no OneCLI step.

**Phase 2 — Pin trusted runtime.** Add `.nvmrc`/`engines` (Node 22). Remove
`better-sqlite3` from `onlyBuiltDependencies`; vendor the prebuilt `.node` + root
postinstall copy; drop stale `protobufjs`/`sharp` allowlist entries. Prove
`pnpm install --prod --frozen-lockfile` on Node 22 pulls only pinned packages, runs no
third-party build script, and the host boots. Full test suite green on Node 22.

**Phase 3 — Slim to Slack + Gmail + Calendar.** Vendor Slack (two-way) from the
`channels` branch and commit (so corp never `git fetch`es). Rewrite `add-gmail-tool`
and `add-gcal-tool` to native Google OAuth (drop OneCLI stubs). Remove all other
channels/providers/skills/container-skills per the Inventory. Slim the Dockerfile.

**Phase 4 — Build & package the container image.** Slimmed, pinned Dockerfile;
build here; `docker save` tarball; document `docker load` + Colima wiring.

**Phase 5 — Auditable trusted-package manifest.** Generate a pinned list of every
package + version: host prod deps (from `pnpm-lock.yaml`, `--prod`), the vendored
binary (name/version/sha256), and the container image's global installs + base-image
digest. This is the artifact corp security reviews.

## Success criteria

- On the corp laptop (Node 22 + Colima), with the shipped `dist/`, vendored binary,
  and loaded image:
  - `pnpm install --prod --frozen-lockfile` completes pulling **only** pinned packages
    from the npm registry, running **no** third-party install/build scripts, with
    **no** compilation and **no** GitHub fetch.
  - `node dist/index.js` boots: credential proxy up, Slack connected, a session
    container spawns under Colima, Gmail + Calendar tools usable with real Google OAuth.
- No `curl | sh`, no OneCLI, anywhere in the install path.
- The manifest accounts for every host + container package with a pinned version.

## Open items / risks

- **Exact Slack env-var set** (`SLACK_BOT_TOKEN` + app/signing) — confirm when
  vendoring the adapter.
- **`gcal-mcp` package + pinned version** — confirm from `add-gcal-tool` during Phase 3.
- **`tsc` emits `setup/`** — verify so corp runs setup without `tsx`; if not, add setup
  to the build output or accept `tsx` as a dev dep on corp.
- **Colima socket/`DOCKER_HOST`** — confirm NanoMika's container-runtime detection
  picks up Colima cleanly.
- **Prebuilt binary provenance** — record how `better_sqlite3.node` was produced and
  its sha256 so the vendored binary is auditable, not opaque.

## Out of scope

- Gmail as an inbound polling channel (kept as a tool).
- Porting the host to Bun + `bun:sqlite` (large separate migration).
- Any upstream merge/sync (this is a private hard fork).
