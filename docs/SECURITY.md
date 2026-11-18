# Security model

NanoMika is built for one person running it on their own machine. This page says what is protected, how, and what is not.

## Who is trusted

| Party | Trust | Why |
|---|---|---|
| The operator (the OS user who runs the host) | Full | Owns the machine, `.env`, the databases and the local sockets |
| Owners and admins (`user_roles`) | High | Approve what agents and unknown senders may do |
| Members of an agent group | Limited | May talk to that agent. Cannot approve anything. |
| Unknown senders | None | Dropped or held for approval, depending on the chat's policy |
| Agents (code in containers) | Sandboxed | Act on message content, which can carry prompt injection |

## 1. Container isolation

Every session runs in its own Docker container, started with `--rm` and removed when it stops. This is the main boundary: an agent can touch only what is mounted into its container.

- Processes run as the unprivileged `node` user, or as the host user's uid when that is not 0 or 1000, so files created in mounted folders belong to you.
- The container gets no host environment. It receives `TZ`, the proxy address and a placeholder credential.
- Containers are labelled with the install they belong to. On start the host removes only its own leftover containers.

Mounted into every container:

| Host path | In the container | Access |
|---|---|---|
| `data/v2-sessions/<agent-group-id>/<session-id>/` | `/workspace` | read-write |
| `groups/<folder>/` | `/workspace/agent` | read-write |
| `groups/<folder>/container.json`, composed `CLAUDE.md`, instruction fragments | under `/workspace/agent` | read-only |
| `data/v2-sessions/<agent-group-id>/.claude-shared/` | `/home/node/.claude` | read-write |
| `container/agent-runner/src/` | `/app/src` | read-only |
| `container/skills/` | `/app/skills` | read-only |
| `container/CLAUDE.md` | `/app/CLAUDE.md` | read-only |

The project root, `.env`, `data/v2.db` and other agents' folders are never mounted.

Docker isolation is weaker than a virtual machine. A container escape in Docker or the kernel would defeat it.

## 2. Extra mounts

An agent group can be given additional host folders. Each one is checked against an allowlist at `~/.config/nanomika/mount-allowlist.json`.

- The file is outside the project and is never mounted, so an agent cannot change it.
- Without the file, every extra mount is refused.
- A path must be inside one of the `allowedRoots`. Symlinks are resolved before the check.
- A root with `allowReadWrite: false` is always mounted read-only.
- Paths containing any of these are refused even inside an allowed root: `.ssh`, `.gnupg`, `.gpg`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.docker`, `credentials`, `.env`, `.netrc`, `.npmrc`, `.pypirc`, `id_rsa`, `id_ed25519`, `private_key`, `.secret`, plus your own `blockedPatterns`.
- These checks look at the folder being mounted, not at the files inside it. Mounting a folder that contains a `.env` gives the agent that file.

See [config-examples/mount-allowlist.json](../config-examples/mount-allowlist.json).

## 3. Credentials

The Anthropic credential is stored only in `.env`.

- Only the credential proxy (`src/credential-proxy.ts`) reads it, straight from the file. It is not loaded into the host's process environment, so child processes do not inherit it.
- A container gets `ANTHROPIC_BASE_URL` pointing at the proxy and a placeholder key or token. The proxy swaps the placeholder for the real credential on each request to the API.
- You can check this: `docker inspect <container>` shows only the placeholder.

The proxy has no authentication. Anything that can reach its port can make API calls with your credential, though it cannot read the credential itself.

- On macOS and WSL the proxy listens on `127.0.0.1`.
- On Linux it listens on the `docker0` bridge address, reachable from containers and the host only. If that interface is not found, the host does not start until you set `CREDENTIAL_PROXY_HOST` to an address your containers can reach.

Agents can call the Anthropic API through the proxy without limit. NanoMika sets no spending cap. Set one on the credential itself.

Channel tokens (for any channel you add) are also read from `.env` and are used only by the host.

## 4. Local sockets

The host listens on two Unix sockets under `data/`, both with mode `0600`:

- `data/cli.sock`: the terminal chat. Messages from it are the user `cli:local`, who is the owner on a fresh install.
- `data/ncl.sock`: the admin CLI. Commands from it run without approval.

Any process running as your OS user can connect to them and act as the owner. Other users on the machine cannot.

## 5. Who may talk to an agent

Each chat (messaging group) has a policy for senders the agent does not know:

| `unknown_sender_policy` | Effect |
|---|---|
| `strict` | The message is dropped |
| `request_approval` | The message is held and an owner or admin is asked to admit the sender |
| `public` | Anyone in the chat is accepted |

A sender is known when they are an owner, an admin (global or for that agent group) or a member of the agent group. A wiring can also require known senders in a `public` chat (`sender_scope: known`).

A message from a chat that is not wired to any agent is never delivered to an agent. If it is a mention or direct message, an owner is asked whether to connect the chat.

Every dropped message is recorded with a reason: `pnpm run ncl dropped-messages list`.

Slash commands are checked on the host before they reach a container (`src/command-gate.ts`). `/clear`, `/compact`, `/context`, `/cost` and `/files` need an owner or admin. `/help`, `/login`, `/logout`, `/doctor`, `/config` and `/remote-control` are dropped. A slash command one agent sends to another gets the same check, and an agent is never an owner or admin.

## 6. What an agent can change

An agent can use `ncl` from inside its container, limited by the group's `cli_scope`:

| `cli_scope` | Effect |
|---|---|
| `disabled` | No `ncl` access |
| `group` (default) | Only `groups`, `sessions`, `destinations` and `members`, and only for its own agent group. It cannot change `cli_scope`. |
| `global` | All resources |

Read operations run directly. Operations that change something (configuration, packages, MCP servers, wirings, roles) are sent to an owner or admin as an approval request showing the exact command. Nothing changes until it is approved, and only an owner or admin can approve: a click from anyone else is ignored.

An agent can send messages only to its destinations, and can always reply to the chat a message came from.

An agent can create another agent with the `create_agent` tool without approval. The new agent has its own folder and container and is reachable only from the agent that created it.

Files an agent sends, to a chat or to another agent, are read from the session's outbox folder. Symlinks and names that point outside the folder are refused, and attachment names are sanitised before anything is written to disk.

## 7. Network

- Containers have unrestricted outbound network access. An agent that reads untrusted content can be tricked into sending data it can see to a third party. Mount only what the agent needs.
- The credential proxy listens on port 3001 (`CREDENTIAL_PROXY_PORT`), as described above.
- The host opens no other listening port. The local CLI channel uses the Unix sockets `data/cli.sock` and `data/ncl.sock`. A channel you add that listens on the network is responsible for authenticating its own requests.

## Not protected

- **Prompt injection.** Message text, web pages and files can instruct the agent. Isolation limits the damage but does not prevent the attempt.
- **Data in the agent's folder.** Everything in `groups/<folder>/` and in the session folder is readable and writable by that agent.
- **Other processes of your OS user.** They can read `.env`, the databases and the sockets.
- **Races in the session folder.** The host refuses symlinks in a session folder before it reads or writes there, and checks again after reading. An agent that swaps a folder for a symlink between the check and the write could still redirect that write. Node has no API that closes this gap fully.
- **Linux.** The Linux code paths have not been tested in this release.

## Reporting a vulnerability

Please report security problems privately through GitHub: on the repository page open **Security → Report a vulnerability**. Do not open a public issue for them.
