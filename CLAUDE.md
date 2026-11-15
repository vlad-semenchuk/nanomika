# NanoMika

A small personal Claude agent. See [README.md](README.md) for setup and use. The architecture docs are in `docs/`.

## Quick Context

The host is a single Node process that orchestrates per-session agent containers. Messages arrive through channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), get written into the session's inbound DB, and wake a container. The agent-runner inside the container polls the DB, calls Claude, and writes back to the outbound DB. The host polls the outbound DB and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the only link.

There is no installer and no service manager. The host runs in the foreground with `pnpm start`. First start creates the first agent and wires it to the local terminal (`src/bootstrap.ts`).

## Entity Model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id) — DM lookup cache

agent_groups (workspace, memory, CLAUDE.md, personality, container config)
    ↕ many-to-many via messaging_group_agents (session_mode, engage_mode, sender_scope)
messaging_groups (one chat/channel on one platform; unknown_sender_policy)

sessions (agent_group_id + messaging_group_id + thread_id → per-session container)
```

Privilege is user-level (owner/admin), not agent-group-level. See [docs/isolation-model.md](docs/isolation-model.md) for the three isolation levels (`agent-shared`, `shared`, separate agents).

## Two-DB Session Split

Each session has **two** SQLite files under `data/v2-sessions/<agent_group_id>/<session_id>/`:

- `inbound.db` — host writes, container reads. `messages_in`, `delivered`, `destinations`, `session_routing`.
- `outbound.db` — container writes, host reads. `messages_out`, `processing_ack`, `session_state`, `container_state`.

Exactly one writer per file, so there is no lock contention across the mount. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

## Central DB

`data/v2.db` holds everything that isn't per-session: users, user_roles, agent_groups, messaging_groups, wiring, container_configs, pending_approvals, user_dms, chat_sdk_* (for the Chat SDK bridge), schema_version. The migrations in `src/db/migrations/` define the schema; [docs/db-central.md](docs/db-central.md) describes every table.

For ad-hoc queries use `pnpm exec tsx scripts/q.ts <db> "<sql>"` rather than the `sqlite3` CLI, which may not be installed. Prefer `ncl` for changes.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: startup checks, DB + migrations, first-start bootstrap, credential proxy, channel adapters, delivery polls, sweep, shutdown |
| `src/bootstrap.ts` | First start: creates the first agent, the `cli:local` owner and their wiring |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions (scheduling, approvals, agent creation) |
| `src/host-sweep.ts` | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db` / `outbound.db`; manages heartbeat path |
| `src/container-runner.ts` | Builds mounts and `docker run` arguments, spawns and kills per-session containers |
| `src/container-runtime.ts` | Docker checks (runtime running, image present), host gateway, orphan cleanup |
| `src/credential-proxy.ts` | Host HTTP proxy that adds the real Anthropic credential to container requests |
| `src/command-gate.ts` | Router-side slash-command gate — checks `user_roles` for admin commands |
| `src/group-init.ts` | Per-agent-group filesystem scaffold |
| `src/claude-md-compose.ts` | Composes the `CLAUDE.md` an agent sees from `container/CLAUDE.md` and module fragments |
| `src/container-config.ts`, `src/db/container-configs.ts` | Per-group container config: DB rows, materialized to `groups/<folder>/container.json` at spawn |
| `src/container-restart.ts` | Kill + on-wake respawn for agent group containers |
| `src/channels/` | Channel adapters (`cli.ts`, `slack.ts`), the registry, the Chat SDK bridge |
| `src/cli/` | The `ncl` admin CLI: socket server, dispatcher, resources |
| `src/db/` | DB layer and migrations |
| `src/modules/permissions/` | Sender resolution, access gate, sender and channel approval flows, `user_dms` |
| `src/modules/approvals/` | `pickApprover`, `pickApprovalDelivery`, `requestApproval`, approval response handling |
| `src/modules/agent-to-agent/` | Agent destinations, agent-to-agent routing, `create_agent` |
| `src/modules/scheduling/` | Scheduled tasks and recurrence |
| `src/modules/mount-security/` | Validates extra mounts against `~/.config/nanomika/mount-allowlist.json` |
| `container/agent-runner/src/` | Agent-runner: poll loop, formatter, provider abstraction, MCP tools, destinations |
| `container/skills/` | Skills mounted into every agent session (`welcome`, `agent-browser`, `slack-formatting`) |
| `container/CLAUDE.md` | Base instructions shared by every agent |
| `scripts/chat.ts` | The `pnpm run chat` terminal client |
| `groups/<folder>/` | Per-agent-group files (`CLAUDE.local.md`, skills, working files). Not committed. |

## Channels

Only the local terminal channel (`src/channels/cli.ts`, socket `data/cli.sock`) is enabled. The Slack adapter is in the tree with its import commented out in `src/channels/index.ts`.

A channel is one file under `src/channels/` that implements `ChannelAdapter` (`src/channels/adapter.ts`) and calls `registerChannelAdapter`, plus one import line in `src/channels/index.ts`. See [docs/writing-a-channel.md](docs/writing-a-channel.md).

Only the `claude` agent provider exists (`src/providers/`, `container/agent-runner/src/providers/`), plus a `mock` provider for tests.

## Admin CLI (`ncl`)

`ncl` queries and modifies the central DB. On the host it connects via Unix socket (`src/cli/socket-server.ts`, `data/ncl.sock`); inside containers it uses the session DB transport (`container/agent-runner/src/cli/ncl.ts`). From the repo, run it as `pnpm run ncl …` or `bin/ncl …`.

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help
ncl help
```

| Resource | Verbs | What it is |
|----------|-------|------------|
| groups | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package | Agent groups (workspace, personality, container config) |
| messaging-groups | list, get, create, update, delete | A single chat/channel on one platform |
| wirings | list, get, create, update, delete | Links a messaging group to an agent group (session mode, engage mode) |
| users | list, get, create, update | Platform identities (`<channel>:<handle>`) |
| roles | list, grant, revoke | Owner / admin privileges (global or scoped to an agent group) |
| members | list, add, remove | Unprivileged access gate for an agent group |
| destinations | list, add, remove | Where an agent group can send messages |
| sessions | list, get | Sessions (read-only) |
| user-dms | list | DM lookup cache (read-only) |
| dropped-messages | list | Messages that were not routed, with the reason (read-only) |
| approvals | list, get | Pending approval requests (read-only) |

Flags are the column names in kebab-case (`--agent-group-id`). Key files: `src/cli/dispatch.ts` (dispatcher + approval handler), `src/cli/crud.ts` (generic CRUD registration), `src/cli/resources/` (per-resource definitions).

## Container Config

Per-agent-group container config (provider, model, effort, packages, MCP servers, mounts) lives in the `container_configs` table. It is written to `groups/<folder>/container.json` at spawn time so the runner can read it. Manage it with `ncl groups config get/update`.

**`cli_scope`** controls what the agent can do with `ncl` from inside the container:

| Value | Behavior |
|-------|----------|
| `disabled` | Agent never learns about ncl (instructions excluded from CLAUDE.md). Host dispatch rejects any `cli_request`. |
| `group` (default) | Agent can access `groups`, `sessions`, `destinations`, `members` only, scoped to its own agent group. `--id` and group args are auto-filled. Cross-group access rejected. `cli_scope` changes blocked. |
| `global` | Unrestricted. |

Write operations requested by an agent raise an approval card to an owner or admin (`src/cli/dispatch.ts`). The same commands run from the host socket are applied directly.

Key files: `src/db/container-configs.ts`, `src/container-config.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts` (instructions exclusion).

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. Kills running containers; if `--message` is provided, writes an `on_wake` message and respawns via the `onExit` callback. Without `--message`, containers come back on the next user message. `--rebuild` first builds a per-group image with the group's extra packages. From inside a container, `--id` is auto-filled and only the calling session is restarted.

The `on_wake` column on `messages_in` ensures wake messages are only picked up by a fresh container's first poll. This prevents a dying container (still in its SIGTERM grace period) from taking the message.

Key files: `src/container-restart.ts`, `src/container-runner.ts` (`killContainer`, `buildAgentGroupImage`), `container/agent-runner/src/db/messages-in.ts` (`getPendingMessages`).

## Secrets and the credential proxy

The Anthropic credential lives only in `.env` and is read only by `src/credential-proxy.ts` through `readEnvFile` (`src/env.ts`). It is never put into `process.env`, never mounted and never passed to a container.

- Containers get `ANTHROPIC_BASE_URL=http://host.docker.internal:3001` and a placeholder key or token. The proxy replaces the placeholder with the real credential on the way out.
- Supported credentials: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL`.
- The proxy binds to `127.0.0.1` on macOS and WSL, and to the `docker0` bridge address on Linux (the host refuses to start without `CREDENTIAL_PROXY_HOST` when there is no `docker0`). It has no authentication of its own, so it must not be exposed on a public interface.
- Channel tokens (Slack) are also read from `.env` with `readEnvFile` and used host-side only.

When changing this code: do not log credential values, do not add a credential to a container's environment, and do not read secrets through `process.env`. [docs/SECURITY.md](docs/SECURITY.md) has the full model.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm start               # Build, then run the host in the foreground
pnpm run dev             # Run the host from source (tsx), no build step
pnpm run build           # Compile host TypeScript (src/ → dist/)
pnpm run build:image     # Build the agent container image (container/build.sh)
pnpm run typecheck
pnpm run lint
pnpm test                # Host tests (vitest)
pnpm run chat <message>  # Talk to the running host
pnpm run ncl <args>      # Admin CLI against the running host

# Agent-runner (Bun — separate package tree under container/agent-runner/)
cd container/agent-runner && bun install   # After editing agent-runner deps
cd container/agent-runner && bun test      # Container tests (bun:test)
```

Container typecheck is a separate tsconfig — if you edit `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root.

The host has no hot reload: after changing `src/`, stop it with Ctrl-C and start it again. `container/agent-runner/src/` is mounted into containers, so a change there applies to the next container that starts, without an image rebuild. Changes to `container/Dockerfile` need `pnpm run build:image`.

Host source is limited to 14,000 lines (`src/**/*.ts` without tests). Check with `git ls-files src | grep '\.ts$' | grep -v '\.test\.ts$' | xargs wc -l | tail -1`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before preparing a pull request.

## Troubleshooting

| What | Where |
|------|-------|
| Host logs | The terminal running `pnpm start`. There are no log files. `LOG_LEVEL=debug pnpm start` shows the full routing chain. |
| Was the message routed? | `pnpm run ncl dropped-messages list`, `pnpm run ncl sessions list` |
| Session DBs | `data/v2-sessions/<agent-group-id>/<session-id>/` — `inbound.db` (`messages_in`: did the message reach the container?), `outbound.db` (`messages_out`: did the agent produce a response?) |
| Startup stops with `FATAL` | The message names the fix: no credential in `.env`, Docker not running, image not built, or checkout path too long for a Unix socket |
| Host waits before starting | Crash-loop backoff (`src/circuit-breaker.ts`). A clean stop resets it. |

Container logs are lost after the container exits (`--rm`). If the agent failed silently inside the container, look at the host log for the container's stderr lines and at the session DBs.

## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

| Doc | Purpose |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | Full architecture writeup |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | Diagram version of the architecture |
| [docs/writing-a-channel.md](docs/writing-a-channel.md) | Adding a channel, with a complete example |
| [docs/isolation-model.md](docs/isolation-model.md) | Three-level channel isolation model |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model |
| [docs/api-details.md](docs/api-details.md) | Host API + DB schema details |
| [docs/db.md](docs/db.md) | DB architecture overview: three-DB model, cross-mount rules, readers/writers map |
| [docs/db-central.md](docs/db-central.md) | Central DB (`data/v2.db`) — every table + migration system |
| [docs/db-session.md](docs/db-session.md) | Per-session `inbound.db` + `outbound.db` schemas + seq parity |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | Agent-runner internals + MCP tool interface |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | Runtime split (Node host + Bun container), lockfiles, image build surface, CI, key invariants |
| [docs/SDK_DEEP_DIVE.md](docs/SDK_DEEP_DIVE.md) | Notes on the Claude Agent SDK internals |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `pnpm run build:image`.

## Container Runtime (Bun)

The agent container runs on **Bun**; the host runs on **Node** (pnpm). They communicate only via session DBs — no shared modules. Details and rationale: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding or bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit the updated `bun.lock`. Do not run `pnpm install` there — agent-runner is not a pnpm workspace.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → no `minimumReleaseAge` policy applies to this tree. Check the release date on npm, pin deliberately, never `bun update` blindly.
- **Writing a new named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host. Positional `?` params work normally.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** (like `agent-browser`, `claude-code`) → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g` — that bypasses the pnpm supply-chain policy.
- **Changing the Dockerfile entrypoint or the spawn command** (`buildContainerArgs` in `src/container-runner.ts`) → keep `exec bun ...` so signals forward cleanly. The image has no `/app/dist`; don't reintroduce a tsc build step.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility. Read the comment block at the top of the file first.

## CJK font support

Agent containers ship without CJK fonts by default (~200MB saved). If you notice signals the user works with Chinese/Japanese/Korean content — conversing in CJK, CJK timezone (e.g., `Asia/Tokyo`, `Asia/Shanghai`, `Asia/Seoul`, `Asia/Taipei`, `Asia/Hong_Kong`), system locale hint, or mentions of needing to render CJK in screenshots/PDFs/scraped pages — offer to enable it:

```bash
# Ensure .env has INSTALL_CJK_FONTS=true (overwrite or append)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# Rebuild the image, then restart the host so new sessions use it
pnpm run build:image
```

`container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through as a Docker build-arg. Without CJK fonts, Chromium-rendered screenshots and PDFs containing CJK text show tofu (empty rectangles) instead of characters.
