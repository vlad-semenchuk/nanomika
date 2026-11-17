# NanoMika

A small personal Claude agent you can read end to end. One Node process on your machine routes messages to agents that each run in their own Docker container. You talk to it from your terminal, and you can add your own channel in one file.

- **Small.** About 13,200 lines of host TypeScript, kept under a 14,000-line budget.
- **Isolated.** Each agent session runs in a Linux container and sees only what is mounted into it.
- **Your key stays on the host.** Containers get a placeholder credential. A proxy on the host adds the real one to outgoing API requests.
- **No installer.** Clone, install, build the image, start.

## Requirements

- macOS or Linux
- Node.js 24 and pnpm 10
- Docker (Docker Desktop on macOS, Docker Engine on Linux), running
- An Anthropic API key, or a Claude subscription token

This release was tested on macOS. The Linux code paths exist (proxy bind address, `host.docker.internal` mapping) but have not been tested. On Linux your user must be able to run `docker` without `sudo`.

## Quick start

```bash
git clone https://github.com/vlad-semenchuk/nanomika.git
cd nanomika
pnpm install
cp .env.example .env        # then open .env and set ANTHROPIC_API_KEY
pnpm run build:image        # builds the agent image; takes a few minutes the first time
pnpm start
```

Leave `pnpm start` running. In a second terminal:

```bash
pnpm run chat hello
```

The first message takes a few seconds longer because it starts the container.

Keep the checkout path short, for example `~/nanomika`. The host listens on Unix sockets under `data/`, and macOS limits a socket path to 103 bytes. The host stops with a clear message if the path is too long.

### What the first start does

When the database has no agents, the host creates:

- an agent named `Andy` (set `ASSISTANT_NAME` in `.env` before the first start to change it), with its folder at `groups/main/`
- the user `cli:local`, your terminal, with the owner role
- the wiring between your terminal and that agent

Later starts change nothing. If something is missing, the host stops before doing any work and names the fix: no credential in `.env`, Docker not running, or the agent image not built.

## Talking to your agent

```bash
pnpm run chat <message>     # send a message, print the reply
pnpm run chat               # print what arrived while no chat was open
```

`pnpm run chat` exits two seconds after the reply. Anything the agent sends later (a scheduled task's output, a slow follow-up) is kept by the host and printed as `[earlier]` the next time you run `pnpm run chat`. This backlog is in memory, so it does not survive a host restart.

To change how the agent behaves, edit `groups/main/CLAUDE.local.md`. It is loaded into every session of that agent.

### Approvals and questions

Some actions need the owner's approval, for example when an agent changes its own configuration with `ncl`. The request appears in your terminal with numbered options:

```
❓ CLI: groups-config-update
Agent "Andy" wants to run:
`ncl groups-config-update --max-messages-per-prompt 7 --agent-group-id ag-… --group ag-… --id ag-…`
  1. Approve
  2. Reject
Answer with: pnpm run chat /answer appr-1763200000000-ab12cd <1-2>
```

```bash
pnpm run chat /answer appr-1763200000000-ab12cd 1
```

Answer with the number or the option name. The same works for questions the agent asks you with a list of choices.

## Admin CLI: `ncl`

`ncl` reads and changes the central database through the running host: agents, chats, wirings, users and roles.

```bash
pnpm run ncl help
pnpm run ncl groups list
pnpm run ncl wirings list
pnpm run ncl groups config get --id <agent-group-id>
```

To call it as plain `ncl` from any directory, link the launcher into your `PATH`:

```bash
ln -s "$(pwd)/bin/ncl" /usr/local/bin/ncl
```

Every resource explains itself with `ncl <resource> help`. The resources are `groups`, `messaging-groups`, `wirings`, `users`, `roles`, `members`, `destinations`, `sessions`, `user-dms`, `dropped-messages` and `approvals`.

## How it works

```
 terminal / your channel
          │  message                                  ▲  reply
          ▼                                           │
 ┌───────────────────── host (Node) ─────────────────────────┐
 │  channel adapter → router ──────────┐   delivery → adapter │
 │  central DB: data/v2.db             │       ▲              │
 │  credential proxy (adds the key)    │       │              │
 └─────────────────────────────────────┼───────┼──────────────┘
                                       ▼       │
                  per session:    inbound.db  outbound.db
                                       │       ▲
                                       ▼       │
 ┌───────────── agent container (Bun, Claude Agent SDK) ──────┐
 │  poll inbound.db → run Claude → write outbound.db          │
 │  Anthropic API calls go out through the host proxy         │
 └────────────────────────────────────────────────────────────┘
```

- A channel adapter receives a message and hands it to the router.
- The router finds the chat (a *messaging group*), the agent wired to it (an *agent group*) and the *session*, writes the message to that session's `inbound.db`, and starts the container if it is not running.
- The agent-runner in the container polls `inbound.db`, runs Claude, and writes replies to `outbound.db`.
- The host polls `outbound.db` and delivers replies through the same adapter.

Each of the two session files has exactly one writer, and they are the only link between host and container.

| Path | What it is |
|---|---|
| `src/index.ts` | Entry point: startup checks, database, first-start bootstrap, proxy, channels, delivery, sweep |
| `src/router.ts` | Inbound routing |
| `src/delivery.ts` | Outbound delivery and system actions |
| `src/container-runner.ts` | Starts and stops agent containers |
| `src/credential-proxy.ts` | Adds the real credential to API requests from containers |
| `src/channels/` | Channel adapters and their registry |
| `src/cli/` | The `ncl` admin CLI |
| `src/db/` | Central database and migrations |
| `container/agent-runner/` | The code that runs inside the container |
| `groups/<folder>/` | Per-agent files (instructions, skills). Not committed. |
| `data/` | Databases, sockets and session files. Not committed. |

## Adding a channel

A channel is one file under `src/channels/` that implements the `ChannelAdapter` interface and registers itself, plus one import line in `src/channels/index.ts`. [docs/writing-a-channel.md](docs/writing-a-channel.md) walks through it with a complete example.

## Configuration

Secrets and a few settings live in `.env`. See [.env.example](.env.example) for the full list.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | API key. One credential is required. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Alternative: a Claude subscription token |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | Alternative: a bearer token and endpoint for an Anthropic-compatible gateway |
| `ASSISTANT_NAME` | Name of the first agent (default `Andy`) |
| `TZ` | Timezone for scheduled tasks (default: the system timezone) |
| `INSTALL_CJK_FONTS` | `true` adds Chinese, Japanese and Korean fonts to the agent image. Rebuild the image after changing it. |

A few settings are read from the process environment instead, for example `LOG_LEVEL=debug pnpm start`.

Per-agent settings (model, effort, extra packages, MCP servers) are in the database: see `pnpm run ncl groups help`.

### Giving an agent access to host folders

By default a container sees only its own agent folder and session files. Extra host folders must be inside a root listed in `~/.config/nanomika/mount-allowlist.json`, which lives outside the project so that no agent can edit it. Start from [config-examples/mount-allowlist.json](config-examples/mount-allowlist.json). Without that file, every extra mount is refused.

## Security

- Agents run in containers and can touch only what is mounted. The project's `.env` is never mounted.
- The Anthropic credential is read from `.env` by the host proxy. A container's environment holds only a placeholder, which you can confirm with `docker inspect`.
- The local sockets (`data/cli.sock`, `data/ncl.sock`) are readable by your user only. Anyone who can connect to them acts as the owner.
- Agents have unrestricted outbound network access.

See [docs/SECURITY.md](docs/SECURITY.md) for the full model.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FATAL: no Anthropic credential found in .env` | Set `ANTHROPIC_API_KEY` (or one of the alternatives) in `.env` |
| `FATAL: Container runtime failed to start` | Start Docker, check `docker info` |
| `FATAL: agent image … not found` | `pnpm run build:image` |
| `FATAL: the socket path is too long` | Move the checkout to a shorter path |
| `FATAL: port 3001 is in use` | Another host is running from this checkout; stop it, or set `CREDENTIAL_PROXY_PORT` |
| `chat: cannot reach NanoMika host` | Start the host with `pnpm start` in another terminal |
| The host waits before starting | It was restarted several times in quick succession and is backing off. A clean stop with Ctrl-C resets this. |
| No reply | Read the host's terminal output. `pnpm run ncl sessions list` and `pnpm run ncl dropped-messages list` show whether the message was routed. |

The host logs to its terminal. After changing files under `container/`, run `pnpm run build:image` again.

## Development

```bash
pnpm dev                    # run the host from source
pnpm run typecheck
pnpm run lint
pnpm test                   # host tests (vitest)
(cd container/agent-runner && bun install --frozen-lockfile && bun test)   # container tests (needs Bun)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Doc | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The full architecture |
| [docs/writing-a-channel.md](docs/writing-a-channel.md) | Adding your own channel |
| [docs/isolation-model.md](docs/isolation-model.md) | Sharing or separating agents and sessions across chats |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model |
| [docs/db.md](docs/db.md) | The databases |
| [docs/README.md](docs/README.md) | Index of all docs |

## License

[MIT](LICENSE)
