# NanoMika Architecture

## Core Idea

Each agent session has a mounted session folder holding two SQLite DBs. The DBs are the one and only IO mechanism between host and container. No IPC files, no stdin piping. `inbound.db` holds `messages_in` (host → agent-runner); `outbound.db` holds `messages_out` (agent-runner → host). Everything is a message.

## Two-Level DB

**Central DB (host process, `data/v2.db`):**
- Agent groups, messaging groups, wiring, sessions, users and roles
- Maps platform IDs → messaging groups → agent groups → sessions
- Channel adapters don't touch this directly — the host does the lookup

**Per-session DBs (mounted into container, `data/v2-sessions/<agent_group_id>/<session_id>/`):**
- `inbound.db` — `messages_in` (written by host, read by agent-runner), plus `delivered`, `destinations`, `session_routing`
- `outbound.db` — `messages_out` (written by agent-runner, read by host), plus `processing_ack`, `session_state`, `container_state`
- Everything is a message: chat, tasks, system actions, agent-to-agent — all use `messages_in` / `messages_out`
- One pair of DBs per session, not per agent group
- Exactly one writer per file

See [db.md](db.md), [db-central.md](db-central.md) and [db-session.md](db-session.md) for the full schemas.

## Agent Groups vs Sessions

An agent group has its own filesystem — folder, CLAUDE.md, skills, container config. Multiple sessions can share the same agent group (same filesystem, same skills) but each session gets its own session folder mounted at `/workspace`. Each session = a separate container with the same agent group's filesystem but different session DBs.

## Message Flow

```
Platform event
  → Channel adapter (receive, ID extraction, mention detection)
  → Calls setup.onInbound(platformId, threadId, message)
  → Router (src/router.ts) maps channelType + platformId → messaging group → wired agent groups
  → Router evaluates each wiring (engage_mode, sender_scope, access gate) and resolves the session
  → Host writes message to session's inbound.db
  → Host calls wakeContainer(session)
  → Container spins up (or is already running)
  → Agent-runner polls inbound.db, finds new messages
  → Agent-runner processes with Claude
  → Agent-runner writes response to outbound.db
  → Host polls session outbound DBs for responses
  → Host reads response, validates the destination, delivers through channel adapter
```

## Channel Adapters

Channel adapters are responsible for:
1. Receiving platform events (webhooks, polling, websockets, a local socket — platform-specific)
2. **Filtering**: deciding which platform messages to forward to the host. The adapter also reports whether the bot was mentioned (`isMention`) and whether the conversation is a group (`isGroup`); the router uses these flags.
3. Extracting and standardizing two IDs:
   - **Platform channel ID** — identifies the conversation (a Slack channel, a DM, the local CLI terminal)
   - **Platform thread ID** — optional sub-context (a Slack thread)
4. Outbound delivery — sending responses back to the platform

The channel adapter does NOT know about agent group IDs or session IDs. It returns platform-level identifiers. The host maps those to the entity model.

The interface is `ChannelAdapter` in `src/channels/adapter.ts`. Adapters self-register with `registerChannelAdapter()` (`src/channels/channel-registry.ts`) when imported from the barrel `src/channels/index.ts`. Only the local CLI channel (`src/channels/cli.ts`) is imported by default; `src/channels/slack.ts` is in the tree with its import line commented out. To add another channel, see [writing-a-channel.md](writing-a-channel.md).

The two-level ID scheme (channel ID + thread ID) gives flexibility. An adapter declares `supportsThreads`:
- `supportsThreads: false` — the router strips thread IDs; the channel itself is the conversation.
- `supportsThreads: true` — in group chats each thread gets its own session (unless the wiring is `agent-shared`); DMs collapse to one session.

### Channel Adapter Configuration

Adapters receive callbacks from the host at setup time (`ChannelSetup`: `onInbound`, `onInboundEvent`, `onMetadata`, `onAction`), not DB config.

**What lives in code (per channel type, doesn't change at runtime):**
- Platform-specific connection and message handling
- Credentials, read from `.env` by the adapter module itself
- Whether the platform uses threads (`supportsThreads`)

These are decisions made when writing the channel adapter. Change them = change the code.

**What lives in the DB (per messaging group / wiring, varies group to group):**
- Which agent groups handle it (`messaging_group_agents`)
- Engage rules: `engage_mode` (`pattern` | `mention` | `mention-sticky`) and `engage_pattern`
- Sender rules: `unknown_sender_policy` on the messaging group, `sender_scope` on the wiring
- What happens to non-engaging messages: `ignored_message_policy` (`drop` | `accumulate`)
- Session mode (`shared` | `per-thread` | `agent-shared`)

The router reads these rules from the DB on every message, so changes made with `ncl` take effect immediately without touching the adapter.

### Auto-Registration

When a message arrives for a conversation with no `messaging_groups` row, the router decides whether to create one.

- Plain messages in unknown conversations are ignored — no row, no DB writes.
- If the bot was addressed (mention or DM), the router creates the messaging group with `unknown_sender_policy = 'request_approval'` and no wiring.
- A mention in a messaging group with no wiring is recorded as a dropped message and handed to the channel-request gate (permissions module, `src/modules/permissions/channel-approval.ts`), which asks an owner to approve the channel. A denied channel (`denied_at` set) is dropped silently afterwards.

**Session creation for wired groups:**
- `shared` mode: host finds the existing session for (agent group, messaging group) or creates one if it's the first message
- `per-thread` mode: host looks up by thread ID. If no session exists for this thread, it creates one with the same agent group
- `agent-shared` mode: one session per agent group across all messaging groups wired this way

No `channel_configs` table — channel-type-level behavior is in the adapter code.

### Chat SDK Integration

Chat SDK adapters are wrapped per-channel by `src/channels/chat-sdk-bridge.ts`:
- Each Chat SDK adapter gets its own Chat instance
- Concurrency mode is configured per-channel (default `concurrent`)
- The bridge wraps the Chat instance + adapter to conform to NanoMika's `ChannelAdapter` interface
- Chat SDK handles: webhook parsing, dedup, platform API calls, rich content delivery. Its state is stored in the central DB (`chat_sdk_*` tables, `src/state-sqlite.ts`)
- NanoMika handles: routing, agent lifecycle, session management

Webhook-mode Chat SDK adapters are served by `src/webhook-server.ts` (`/webhook/{adapterName}`), started lazily on first registration.

**Chat SDK's subscription model:**

Chat SDK has its own thread-level subscription concept (distinct from NanoMika's channel-level registration):
- `onNewMention` / `onNewMessage(regex)` — fires on first contact (e.g., @mention in a Slack thread)
- `thread.subscribe()` — opts into all future messages in that thread
- `onSubscribedMessage` — fires for all messages in subscribed threads

This is sub-channel granularity. NanoMika registers at the channel level. Chat SDK subscribes at the thread level. The router asks the adapter to `subscribe()` a thread when a `mention-sticky` wiring first engages there.

**Platform capability differences:**

Capabilities vary significantly across Chat SDK adapters (see [Chat SDK adapter docs](https://chat-sdk.dev/docs/adapters)). Slack, the one Chat SDK channel in the tree, supports rich content (Block Kit cards, reactions, edits). Other platforms differ — some have no cards, reactions or edits.

The bridge handles graceful degradation — if an agent posts a card on a platform that doesn't support cards, it falls back to text.

Non-Chat-SDK channels, such as the local CLI channel, implement the `ChannelAdapter` interface directly — no bridge, no Chat SDK types.

## Container Lifecycle

The host is an orchestrator:
1. **Spawn** — when `wakeContainer` is called and no container exists for the session (concurrent wakes for the same session share one spawn)
2. **Stuck / idle kill** — the host sweep kills a running container whose heartbeat file is older than 30 minutes, or that claimed a message and showed no sign of life within the tolerance window (see [Host Polling](#host-polling))
3. **Exit** — when the container process exits, the host marks the session's container stopped

When a container spins up, the agent-runner immediately starts polling its inbound DB. Messages are already there waiting.

## Media Handling

### Inbound

Media is not downloaded by the host. Instead:
- A channel adapter either passes attachment URLs through, or includes the file bytes as base64 `data` on the attachment (the Chat SDK bridge does this)
- When an attachment carries `data`, the host writes it to the session folder at `inbox/{messageId}/{filename}` and replaces `data` with a `localPath` before writing the `messages_in` row (`src/session-manager.ts`, with path-safety checks)
- The agent-runner lists attachments in the prompt text: saved files as `/workspace/inbox/{messageId}/{filename}`, others by URL. The agent uses tools (Read, Bash) to access them.

### Outbound

Outbound file delivery is tool-based. The agent calls `send_file` with a file path. The agent-runner copies the file into the outbox and writes the messages_out row.

```
/workspace/
  outbox/
    {message_id}/        ← one dir per messages_out row
      chart.png
      report.pdf
```

messages_out content references filenames only:

```json
{ "text": "Here's the chart", "files": ["chart.png"] }
```

No paths in the DB — the convention is the contract. The host reads files from `outbox/{message_id}/` in the mounted session folder and delivers them via the adapter. Host cleans up the outbox directory after successful delivery.

Outbound files use a dedicated `send_file` MCP tool (separate from `send_message`). See [agent-runner-details.md](agent-runner-details.md) for the tool interface.

### Message Deduplication

Dedup is the channel adapter's responsibility. Chat SDK handles this internally. Native adapters track platform message IDs as needed. The host does not deduplicate — if the adapter forwards it, the host writes it.

## Session DB Schema

JSON blobs for content — schema-free, format varies by `kind`. The schemas are `INBOUND_SCHEMA` / `OUTBOUND_SCHEMA` in `src/db/schema.ts`; the main tables:

```sql
-- inbound.db: host writes, agent-runner reads
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,     -- host uses even numbers
  kind           TEXT NOT NULL,      -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',  -- 'pending' | 'completed' | 'failed' (+ 'paused' for tasks)
  process_after  TEXT,               -- ISO timestamp. NULL = process immediately.
  recurrence     TEXT,               -- cron expression. NULL = one-shot.
  series_id      TEXT,               -- groups occurrences of a recurring task
  tries          INTEGER DEFAULT 0,  -- number of processing attempts
  trigger        INTEGER NOT NULL DEFAULT 1,  -- 0 = context only (don't wake), 1 = wake agent

  -- routing (agent never sees these)
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,

  -- payload (structure depends on kind)
  content        TEXT NOT NULL,       -- JSON blob

  source_session_id TEXT,             -- agent-to-agent return path
  on_wake        INTEGER NOT NULL DEFAULT 0  -- 1 = only picked up by a fresh container's first poll
);

-- outbound.db: agent-runner writes, host reads
CREATE TABLE messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,     -- container uses odd numbers
  in_reply_to    TEXT,               -- references messages_in.id (optional)
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,               -- ISO timestamp. NULL = deliver immediately.
  recurrence     TEXT,

  -- routing
  kind           TEXT NOT NULL,      -- 'chat' | 'chat-sdk' | 'system'
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,

  -- payload (format matches kind)
  content        TEXT NOT NULL        -- JSON blob
);
```

Processing status is not written to `messages_in` by the container (it cannot write `inbound.db`). The container records claims in `outbound.db`'s `processing_ack`; the host copies them into `messages_in.status`. Delivery outcomes are recorded by the host in `inbound.db`'s `delivered` table, never in `outbound.db`.

### Scheduling

One-shot and recurring tasks use the same tables — no separate scheduler.

**One-shot:** a `kind: 'task'` `messages_in` row with `process_after` and `recurrence = NULL`.

**Recurring:** Same, plus a `recurrence` cron expression (evaluated in the configured timezone). Each host sweep, for every `completed` row that still has a `recurrence`, the scheduling module (`src/modules/scheduling/recurrence.ts`) inserts a new pending row with `process_after` set to the next cron occurrence after the current time, copies `series_id` forward, and clears `recurrence` on the original.

**Host sweep** (every 60s across all active sessions, `src/host-sweep.ts`):
- Sync `processing_ack` (outbound.db) → `messages_in.status` (inbound.db)
- Due `messages_in` rows (`status = 'pending'`, `trigger = 1`, `process_after` NULL or past) and no running container → wake
- Running container: kill if past the heartbeat ceiling or a claim is stuck, then reset its claimed messages with backoff
- No running container but leftover `processing` claims → reset those messages to pending with backoff, increment `tries`
- After a recurring row completes, insert the next occurrence

**Active delivery poll** (~1s, `src/delivery.ts`) delivers due `messages_out` rows for sessions with running containers; a 60s sweep poll does the same for all active sessions.

**Agent-runner creates schedules** with the `schedule_task` tool, which writes a `kind: 'system'` messages_out row; the host inserts the task row into inbound.db.

### messages_in content by kind

**`chat`** — simple NanoMika format. Any channel can produce this.
```json
{
  "sender": "John",
  "senderId": "cli:local",
  "text": "Check this PR",
  "attachments": [{ "type": "image", "name": "shot.png", "localPath": "inbox/msg-1/shot.png" }]
}
```

**`chat-sdk`** — Chat SDK serialized message, passed through from the bridge. Includes `author`, `text`, `attachments`, `isMention`, and other Chat SDK fields.

**`task`** — scheduled task firing.
```json
{ "prompt": "Review open PRs", "script": "./review.sh" }
```

**`webhook`** — raw webhook payload. The formatter supports this kind; no producer in the tree writes it.
```json
{ "source": "github", "event": "pull_request", "payload": { ... } }
```

**`system`** — host response to a tool call the agent is waiting on (e.g. `ask_user_question`). The poll loop skips these; the waiting tool reads them.
```json
{ "type": "question_response", "questionId": "q-123", "selectedOption": "Yes" }
```

### messages_out content by kind

Output `kind` determines how the host handles the row.

**`chat`** — simple NanoMika format. Delivered through the channel adapter's `deliver()`.
```json
{ "text": "LGTM, merging now" }
```

**`chat-sdk`** — cards and questions (`ask_user_question`, `send_card`). The Chat SDK bridge renders them; the CLI channel prints them as text.
```json
{ "type": "card", "card": { "title": "Review", "children": [...] }, "fallbackText": "..." }
```

**`system`** — host action request. Host reads it, dispatches to the handler registered for `action` with `registerDeliveryAction()`, validates permissions, and executes. Registered actions: `schedule_task`, `cancel_task`, `pause_task`, `resume_task`, `update_task` (scheduling module), `create_agent` (agent-to-agent module), `cli_request` (`ncl` from inside the container, `src/cli/delivery-action.ts`).
```json
{ "action": "schedule_task", "taskId": "msg-123", "prompt": "Review open PRs", "processAfter": "2026-01-15T21:00:00.000Z", "recurrence": null }
```

### Interactive Operations (Cards, Reactions, Edits)

All interactive operations flow through messages_in/out — the DBs are the only IO boundary for the container. The agent uses MCP tools; the agent-runner translates tool calls into structured messages_out rows; the host delivers through the appropriate adapter.

**Cards with user interaction (`ask_user_question`):**

1. Agent calls `ask_user_question` tool with title, question and options
2. Agent-runner writes messages_out with the question card
3. Host delivers the card through the adapter (e.g., Slack Block Kit buttons) and records a `pending_questions` row
4. User clicks an option (on the CLI: `/answer <questionId> <option>`)
5. Adapter calls `onAction` → the interactive module writes a `question_response` system row to the session's messages_in and wakes the container
6. Agent-runner's waiting tool call finds the response and returns the selection to the agent as the tool result

The agent-runner holds the tool call open (default timeout 300s) while waiting for the user's response in messages_in. The round-trip goes: agent → messages_out → host → platform → user clicks → platform → host → messages_in → agent-runner → agent.

**Approvals:**

Approvals are host-side. A caller invokes `requestApproval()` (`src/modules/approvals/primitive.ts`) with an action and payload; the module delivers an approval card to an approver and persists a `pending_approvals` row. When the approver clicks, the handler registered with `registerApprovalHandler()` applies the change and notifies the requesting agent. The agent doesn't see the approval step — today it is used for approval-gated `ncl` commands run from inside a container. Unknown-sender and new-channel approvals in the permissions module follow the same card pattern with their own tables (`pending_sender_approvals`, `pending_channel_approvals`).

**Approval routing:** Privilege is a user-level concept. `user_roles` records `owner` (global only — on first start the `cli:local` user is granted owner) and `admin` (global or scoped to a specific `agent_group_id`). When an action requires approval, `pickApprover(agentGroupId)` returns candidates in order: scoped admins for that agent group → global admins → owners (deduplicated). `pickApprovalDelivery` then takes the first candidate reachable via `ensureUserDm` (with a same-channel-kind tie-break so a request from one channel prefers an approver on that channel). The approval card lands in the approver's DM messaging group, not the origin chat. Delivery is resolved through the adapter's `openDM` for channels that distinguish user ID from DM channel ID, or the user's handle directly otherwise, and the mapping is cached in `user_dms` for subsequent requests. See `src/modules/permissions/access.ts`, `src/modules/permissions/user-dm.ts`, `src/modules/approvals/primitive.ts`.

**Editing a sent message:**

Agent calls an `edit_message` tool with the message ID and new content. Agent-runner writes messages_out with an edit operation. The adapter applies the edit. Messages in the agent's context include integer IDs (`seq`) so the agent can reference them.

**Reactions:**

Agent calls `add_reaction` tool with message ID and emoji. Agent-runner writes messages_out with a reaction operation. The adapter adds the reaction.

**Operations in messages_out content:**

```json
// Normal message (default)
{ "text": "LGTM" }

// Interactive card
{ "type": "ask_question", "questionId": "q-1", "title": "Deploy", "question": "Approve deployment?", "options": [{ "label": "Yes", "selectedLabel": "Yes", "value": "Yes" }] }

// Edit existing message
{ "operation": "edit", "messageId": "<platform message id>", "text": "Updated: LGTM with minor comments" }

// Reaction
{ "operation": "reaction", "messageId": "<platform message id>", "emoji": "thumbs_up" }
```

The adapter reads the `operation` / `type` field (if present) and does the right thing. No such field = normal message delivery. Platform capabilities vary — the adapter handles graceful degradation.

### Agent-to-Agent Communication

Sending a message to another agent uses the same routing fields as channel delivery. The agent-runner sets `channel_type: 'agent'` and `platform_id` to the target agent group ID.

From the sending agent's perspective, it's the same mechanism as sending to a chat — the agent addresses a named destination (`send_message` with `to`, or a `<message to="name">` block), and the agent-runner writes a messages_out row with different routing. The host reads it, checks `agent_destinations` to confirm this agent group may message the target, resolves the target session, and writes a messages_in row to that session's DB (`src/modules/agent-to-agent/agent-route.ts`).

```json
// messages_out routing fields
{ "kind": "chat", "channel_type": "agent", "platform_id": "<target agent_group_id>", "thread_id": null }
// messages_out content
{ "text": "Reset your session and re-review" }
```

The receiving agent gets a normal chat message, attributed to the sending agent's destination name.

### Routing

**Default behavior:** Each session has a default reply address in `inbound.db`'s `session_routing` table (written by the host on every wake). Tools that omit a destination use it; result text is routed by its `<message to="name">` blocks.

**Host validation:** Before delivering, the host checks that this agent group is permitted to send to the destination: replies to the session's own origin chat are always allowed; any other channel needs an `agent_destinations` row. The agent-runner picks the routing; the host validates.

**Named destinations (built in):** An agent can send to channels other than the origin. The host writes the agent group's destinations (from `agent_destinations`) into the session's `inbound.db` `destinations` table on every wake; the agent-runner lists them in the prompt and resolves names to routing fields; the host validates as usual. Wiring a messaging group to an agent group adds the destination row automatically.

## Core Properties
- Container isolation via filesystem mounts
- Credential proxy on the host (`src/credential-proxy.ts`) — containers never see the real API key
- Per-agent-group workspace (folder, CLAUDE.md, skills)
- Polling-based (not event-driven)
- Agent-runner source is mounted read-only from `container/agent-runner/src/` and run directly by Bun — no build step in the container
- Host ↔ container IO through mounted session DBs (`inbound.db` / `outbound.db`) — no stdin piping, no IPC files
- Agent commands are `messages_out` rows with `kind: 'system'`
- Agent-to-agent supported via target-agent routing on `messages_out`
- Scheduling uses `process_after` + `recurrence` on the same message tables
- Media: adapter-supplied files saved to the session inbox; URLs passed through
- Channel adapters use a standard interface; Chat SDK adapters go through the bridge. Only the CLI channel is wired by default
- Routing: channel adapter extracts IDs, host maps to entities
- Concurrency: Chat SDK per-channel + one container per session
- Session scoping: per-session DBs, multiple sessions per agent group

## Design Decisions

**Session folder location:** Not in the agent group folder. Separate directory: `data/v2-sessions/{agent_group_id}/{session_id}/`. Each session folder contains `inbound.db`, `outbound.db`, `outbox/`, `inbox/` and the `.heartbeat` file. The Claude SDK's state lives per agent group in `data/v2-sessions/{agent_group_id}/.claude-shared/` (mounted at `/home/node/.claude`); the SDK session ID to resume is stored in the session's `outbound.db` (`session_state`).

**Container mount structure** (`buildMounts()` in `src/container-runner.ts`):

```
/workspace/                 ← mount: session folder (read-write)
  inbound.db                ← host-owned session DB
  outbound.db               ← container-owned session DB
  outbox/                   ← agent-runner writes outbound files here
  inbox/                    ← host writes inbound attachments here
  .heartbeat                ← touched by the agent-runner
  agent/                    ← mount: agent group folder groups/<folder> (nested, read-write)
    CLAUDE.md               ← composed instructions (read-only nested mount)
    CLAUDE.local.md         ← per-group memory (read-write)
    container.json          ← materialized container config (read-only nested mount)
    ... working files
/home/node/.claude/         ← mount: per-group .claude-shared (Claude state, settings, skill symlinks)
/app/src/                   ← mount: container/agent-runner/src (read-only)
/app/skills/                ← mount: container/skills (read-only)
/app/CLAUDE.md              ← mount: container/CLAUDE.md (read-only)
```

Plus any validated `additionalMounts` from the container config and mounts contributed by the provider. The agent-runner runs the agent in `/workspace/agent/`. Only Docker is supported as the container runtime (`src/container-runtime.ts`).

**Session DB concurrent access:** The host writes `inbound.db`, the agent-runner writes `outbound.db`. Each file has exactly one writer. Session DBs use `journal_mode=DELETE` (not WAL — WAL's memory-mapped `-shm` does not stay coherent across the container mount), and the host opens, writes and closes the DB on each operation. See the header of `src/session-manager.ts`.

**Session management:** Host-managed. The host creates session folders and mounts them. The container only sees its own session folder.

**Session creation (no race condition):**

1. Message arrives, router checks central DB for a session matching this agent group + messaging group + thread
2. No session exists → host creates session row in central DB, creates the session folder, creates both session DBs, writes the message
3. More messages arrive before container starts → host finds the existing session, writes to the same inbound DB
4. Container starts, mounts the folder, agent-runner finds messages waiting

The central DB session row creation is the serialization point.

**System actions:** The agent uses MCP tools (schedule task, create agent, `ncl` requests, etc.). The agent-runner handles these tool calls and writes a structured, deterministic messages_out row with `kind: 'system'`. This is not natural language — it's a programmatic, structured payload that the host processes deterministically. Host validates permissions, executes, and notifies the agent by writing to its messages_in.

**Container lifecycle:** No warm pool. Containers are spawned on demand (`wakeContainer`) and torn down from the outside by the host sweep when stuck or idle past the heartbeat ceiling.

## Operational Behavior

### Output Delivery

NanoMika does not stream tokens to users. The agent-runner reads complete results from the provider, splits the result text into `<message to="name">` blocks, and writes one messages_out row per block. Text outside those blocks (and `<internal>` blocks) is scratchpad and is not sent. The host delivers complete messages to channels.

Message editing is supported as an explicit operation (agent calls an `edit_message` tool), not as a streaming mechanism.

Typing indicators: the host starts a typing refresh when it wakes a container for a session (`src/modules/typing/`), pauses it briefly after each delivered message, and stops it when the container exits.

### Message Batching

When multiple messages arrive while the container is down, they accumulate as `pending` rows in messages_in. When the container wakes up, the agent-runner queries pending messages (up to `maxMessagesPerPrompt`, default 10) and processes them as a batch — each message becomes its own `<message>` XML element in one prompt. Messages that arrive while a query is running are pushed into the active query.

### Message Lifecycle

```
pending → processing → completed
                    → failed (after max retries)
```

- **pending**: Written by host. Ready to be picked up (if `process_after` is null or past).
- **processing**: Agent-runner records this in `processing_ack` when it picks up the message; the host sweep copies it to `messages_in.status`.
- **completed**: Agent-runner records this after processing.
- **failed**: Set by the host after max retries exhausted.

**Stale detection**: If a running container claimed a message more than 60s ago (longer while a Bash tool with a longer declared timeout is running) and its heartbeat hasn't moved since the claim, or its heartbeat is older than 30 minutes, the host kills the container. Claimed messages of a dead or killed container are reset to `pending` with `tries` incremented and `process_after` pushed out with exponential backoff.

### Error Handling and Retries

Retries use `process_after` with exponential backoff. Each retry increments `tries` and pushes `process_after` further out:

- Try 1: immediate
- Try 2: +5s
- Try 3: +10s
- Try 4: +20s
- Try 5: +40s
- Try 6: +80s
- After max retries: status set to `failed`

The host computes this — not the agent-runner. When the host detects a stuck claim or a claimed message whose container is gone, it increments `tries`, computes the next `process_after`, and resets status to `pending`.

Delivery failures are retried separately: the host tries each messages_out row up to 3 times, then marks it `failed` in `delivered`.

### Host Polling

Two tiers:
- **Running containers (~1s)**: Poll session outbound DBs for new messages_out rows to deliver
- **All active sessions (~60s)**: Deliver anything left over, sync processing claims, wake for due `process_after` timestamps, enforce stuck rules, handle recurrence

## Flexibility Model

The architecture is **flexible for code changes, not configurable for everything**. Advanced setups use custom routing logic and host-side hooks — not database config columns.

### Code Structure for Customization

NanoMika is customized by changing its code. The code is structured so that:

1. **Different customizations don't conflict.** Adding a channel should not touch the same lines as adding an MCP tool. Each type of customization touches its own file(s).

2. **Core blocks of functionality are in separate files.** Channel registration, message formatting, MCP tools, routing logic, container management — each in its own file. A change to how messages are formatted doesn't touch the file that handles container spawning.

3. **The index file is thin.** `src/index.ts` wires things together (preflight, init DB, start adapters, start poll loops) but contains no business logic. Logic lives in purpose-specific modules (router, delivery, session-manager, host-sweep, `src/modules/*`).

4. **Don't over-split.** A simple change (e.g., adding a new message kind) shouldn't require edits across 5 files. Group related logic together.

5. **Registration patterns over switch statements.** Channels (`registerChannelAdapter`), MCP tools (`registerTools`), providers (`registerProvider`), host modules, delivery actions (`registerDeliveryAction`) and approval handlers (`registerApprovalHandler`) use registration patterns. Adding one means adding a file and a registration call — not editing a central switch statement.

**Practical example:** Adding a new channel requires:
- One new file (the channel adapter, native or via the Chat SDK bridge)
- One line in the barrel file (`src/channels/index.ts`) to import the self-registering module
- Zero changes to routing, formatting, delivery, or container code

See [writing-a-channel.md](writing-a-channel.md).

**Provider mount registration:** Providers that need host-side container setup register a contribution with `src/providers/provider-container-registry.ts` (extra mounts, env vars). The container runner collects the contribution for the session's provider — no need to edit `container-runner.ts`.

**Config pattern:** Each channel module reads its own env vars directly from `.env`:

```typescript
// src/channels/slack.ts
const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN']);
```

Shared config (DATA_DIR, TIMEZONE, CREDENTIAL_PROXY_PORT, …) stays in `src/config.ts`. Channel-specific config stays in the module that uses it.

### Code Style

**Line width: 120 characters.** Most statements fit on one line without sacrificing readability.

**Concise logging.** A thin wrapper (`src/log.ts`) keeps every log call on one line:

```typescript
log.info('Message routed', { sessionId, agentGroup });
log.warn('Message delivery failed, will retry', { messageId, attempt });
log.error('Container spawn error', { sessionId, err });
```

### DB File Structure

The DB layer is split by entity rather than kept in one monolithic file:

```
src/db/
  connection.ts              ← singleton, init, WAL mode (central DB only)
  schema.ts                  ← per-session schemas (inbound.db, outbound.db)
  migrations/
    index.ts                 ← runner: checks schema_version, applies pending
    001-initial.ts           ← initial schema
    002-chat-sdk-state.ts    ← Chat SDK state tables
    ...                      ← numbered core migrations + module-*.ts module migrations
  agent-groups.ts            ← CRUD for agent_groups
  messaging-groups.ts        ← CRUD for messaging_groups + messaging_group_agents
  sessions.ts                ← CRUD for sessions + pending_questions
  container-configs.ts       ← CRUD for container_configs
  dropped-messages.ts        ← audit log of dropped messages
  session-db.ts              ← inbound.db / outbound.db helpers
  index.ts                   ← barrel: re-exports
```

Module-owned tables have their CRUD inside the module (e.g. `src/modules/permissions/db/`, `src/modules/agent-to-agent/db/`).

**Principles:**
- **Split by entity, not by layer.** Each entity file has its own CRUD functions. A change that adds a column to messaging_groups edits `messaging-groups.ts` — doesn't touch sessions or agent groups.
- **Migrations define the central schema.** They are append-only files; [db-central.md](db-central.md) describes the resulting tables. The per-session schemas are plain constants in `schema.ts`.
- **Migration runner.** A `schema_version` table records applied migrations. On startup, the runner applies pending migrations in order. Each migration is a function: `(db: Database) => void`.
- **Modules add migrations.** A module that needs a new table adds its own migration file (`module-<name>-<what>.ts`) to the list.

**Agent-runner session DB** uses the same pattern but lighter — no migrations needed since session DBs are created fresh by the host:

```
container/agent-runner/src/db/
  connection.ts          ← open inbound.db (read-only) + outbound.db at fixed paths, heartbeat
  messages-in.ts         ← read pending, record processing status
  messages-out.ts        ← write results
  session-routing.ts     ← default reply routing
  session-state.ts       ← persisted SDK session ID
  index.ts               ← barrel
```

### What the base architecture supports primitively

These are the building blocks. None require special abstractions — they fall out of per-session DBs, host-managed routing, and messages_out with `kind: 'system'`:

1. **Multiple agent groups on the same channel with content-based routing.** Several agent groups can be wired to one messaging group; each wiring's `engage_mode` / `engage_pattern` decides independently whether that agent engages (fan-out, ordered by `priority`).

2. **Per-thread sessions from a shared agent group.** Multiple sessions share the same agent group (filesystem, skills, CLAUDE.md) but each gets its own session DBs.

3. **Agent-initiated host actions.** The agent uses MCP tools (schedule task, create agent, `ncl` requests, etc.). The agent-runner handles the tool call and writes a structured `system` messages_out row. The host reads and executes with permission checks. The agent can request, but the host decides.

## Central DB Schema

The central DB handles routing and entity management. All content and execution state lives in per-session DBs. Core tables (every table is described in [db-central.md](db-central.md)):

```sql
-- Agent workspaces: folder, skills, CLAUDE.md
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,              -- default for sessions (null = system default)
  created_at       TEXT NOT NULL
);

-- Per-agent-group container config (provider, model, packages, MCP servers, mounts, skills)
-- container_configs (agent_group_id PK, provider, model, effort, image_tag, assistant_name,
--   max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm, additional_mounts, ...)

-- Platform groups/channels (one chat on one platform)
CREATE TABLE messaging_groups (
  id                     TEXT PRIMARY KEY,
  channel_type           TEXT NOT NULL,     -- e.g. 'cli', 'slack'
  platform_id            TEXT NOT NULL,     -- platform-specific ID
  name                   TEXT,
  is_group               INTEGER DEFAULT 0,
  unknown_sender_policy  TEXT NOT NULL DEFAULT 'strict',  -- 'strict' | 'request_approval' | 'public'
  denied_at              TEXT,              -- set when an owner denies channel registration
  created_at             TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

-- Users (messaging platform identities, namespaced "<channel_type>:<handle>")
CREATE TABLE users (
  id           TEXT PRIMARY KEY,   -- e.g. 'cli:local'
  kind         TEXT NOT NULL,      -- mirrors the channel_type prefix
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Roles (owner is global only; admin can be global or scoped to an agent_group)
CREATE TABLE user_roles (
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL,   -- 'owner' | 'admin'
  agent_group_id  TEXT REFERENCES agent_groups(id),  -- NULL for global
  granted_by      TEXT REFERENCES users(id),
  granted_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
-- owner rows must have agent_group_id = NULL (enforced in src/modules/permissions/db/user-roles.ts)

-- Membership (explicit non-privileged access; admin/owner imply membership)
CREATE TABLE agent_group_members (
  user_id         TEXT NOT NULL REFERENCES users(id),
  agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
  added_by        TEXT REFERENCES users(id),
  added_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- DM resolution cache (so cold DMs aren't re-resolved every time)
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Which agent groups handle which messaging groups, with what rules
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT,                             -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,                             -- regex for 'pattern'; '.' = every message
  sender_scope           TEXT,                             -- 'all' | 'known'
  ignored_message_policy TEXT,                             -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',            -- 'shared' | 'per-thread' | 'agent-shared'
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
-- engage_mode, sender_scope and ignored_message_policy have no SQL default.
-- Callers always set them; `ncl wirings create` defaults to mention / all / drop.

-- Sessions: one folder = one session = one container when running
-- Folder path is derived: data/v2-sessions/{agent_group_id}/{session_id}/
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),  -- null for internal/spawned sessions
  thread_id          TEXT,              -- platform thread ID (null for shared session mode)
  agent_provider     TEXT,              -- override per session (null = inherit)
  status             TEXT DEFAULT 'active',    -- 'active' | 'closed'
  container_status   TEXT DEFAULT 'stopped',   -- 'running' | 'idle' | 'stopped'
  last_active        TEXT,              -- last message activity timestamp
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- Pending interactive questions (cards waiting for user response)
-- Host writes when delivering a question card, deletes when response received
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,     -- the messages_out row that sent the card
  platform_id    TEXT,              -- where the card was delivered
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

Other tables: `pending_approvals` (approvals module), `agent_destinations` (agent-to-agent module), `pending_sender_approvals` and `pending_channel_approvals` (permissions module), `unregistered_senders` (dropped-message audit), `chat_sdk_*` (Chat SDK state), `schema_version`.

### Pending Question Flow

When the host delivers a messages_out row whose content has `type: 'ask_question'`:
1. Host writes a `pending_questions` row mapping `question_id` → `session_id`
2. Host delivers the card via the channel adapter

When the user answers (a Chat SDK button click, or `/answer` on the CLI):
1. The adapter calls `onAction(questionId, selectedOption, userId)`
2. The host passes the response to the registered response handlers; the interactive module (`src/modules/interactive/`) looks up `pending_questions` by `question_id`
3. It finds the target session, writes a `question_response` system row with `questionId` + `selectedOption` to its messages_in, and wakes the container
4. It deletes the `pending_questions` row
5. Agent-runner's waiting `ask_user_question` call picks up the row and returns the selection

This avoids scanning session DBs. The central DB is the routing lookup — same pattern as message routing.

Host-generated approval cards use the same `onAction` path but are claimed by the approvals module from `pending_approvals`.

### Container lifecycle states

```
stopped → running → stopped
```

- **stopped**: No container. Swept every 60s for due scheduled messages.
- **running**: Container process alive. Polled every 1s for messages_out. Stays up between turns until it exits or the host sweep kills it (heartbeat older than 30 min, or a stuck claim).

## Agent-Runner Architecture

The agent-runner is the process inside the container (`container/agent-runner/src/`, run by Bun). It mediates between the session DBs and the Claude Agent SDK — polling for work, formatting messages for the agent, translating tool calls into DB rows, and managing the agent lifecycle.

### IO Model

All IO goes through the session DBs. No stdin, no stdout markers, no IPC files.

- Initial input and follow-ups: poll `messages_in`
- Output: write `messages_out` rows
- MCP tools: write DB rows (no IPC files)
- Liveness: touch `/workspace/.heartbeat`
- Shutdown: the host kills the container; the poll loop itself runs until the process is killed

### Poll Loop

1. Query `messages_in` for pending rows (`process_after` NULL or past), skipping `system` rows
2. If none, or only `trigger = 0` rows, sleep 1s and re-poll
3. Record the batch as `processing` in `processing_ack`
4. Handle `/clear` directly; run pre-task scripts for `task` rows
5. Format the rest into a single prompt (strip routing fields, format by kind) and start a provider query
6. While the query runs, poll every 500ms and push follow-up messages into it
7. On each result, split the text into `<message to="name">` blocks → write `messages_out` rows; mark the batch `completed`
8. Back to step 1

### Message Formatting by Kind

Agent-runner strips routing fields (`platform_id`, `channel_type`, `thread_id`) before formatting. The agent never sees routing info — it sees content plus a `from="<destination name>"` attribute. Every prompt starts with a `<context timezone="..."/>` header.

- **`chat`** / **`chat-sdk`** — one `<message id="<seq>" from="..." sender="..." time="...">` element per message, with attachments and quoted replies inline
- **`task`** — `<task>` element with the script output (if any) and the instructions
- **`webhook`** — `<webhook source="..." event="...">` + JSON payload
- **`system`** — skipped by the poll loop; read by the tool waiting for it (e.g. `ask_user_question`)

Mixed batches are combined into one prompt.

### MCP Tools

MCP tools write directly to the session DBs (`container/agent-runner/src/mcp-tools/`).

| Tool | What it does |
|------|-------------|
| `send_message` | Write `messages_out` row, `kind: 'chat'`, to a named destination (default: session routing) |
| `send_file` | Copy file to `outbox/{msg_id}/`, write `messages_out` with filenames |
| `edit_message` | Write `messages_out` with `operation: 'edit'` |
| `add_reaction` | Write `messages_out` with `operation: 'reaction'` |
| `schedule_task` | Write `messages_out`, `kind: 'system'`, `action: 'schedule_task'`; host inserts the task into `messages_in` |
| `list_tasks` | Query `messages_in` for live task series |
| `update_task` / `pause_task` / `resume_task` / `cancel_task` | Write `system` actions; host updates the task rows |
| `ask_user_question` | Write `messages_out` with question card. Hold tool call open, poll `messages_in` for the matching `question_response`. Return selection as tool result. |
| `send_card` | Write `messages_out` with card structure |
| `create_agent` | Write `messages_out`, `kind: 'system'`, `action: 'create_agent'`; host creates the agent group and wires destinations both ways |

See [agent-runner-details.md](agent-runner-details.md) for full MCP tool parameter definitions.

### Cards

**Agent-initiated (outbound):** Tool-based. Agent calls `ask_user_question` (interactive card with options) or `send_card` (structured card). Agent-runner writes the card structure to messages_out. The adapter handles platform-specific rendering (Slack Block Kit on Slack, numbered text options on the CLI, text fallback elsewhere).

**Host-initiated (approval cards):** When an action requires approval, the host generates an approval card and sends it to the approver's DM. These are not agent-initiated — the agent doesn't know about the approval step.

**Inbound (card responses):** Not a card — it's a messages_in row with `questionId` + `selectedOption` in the content. Agent-runner matches it to the pending `ask_user_question` tool call and returns the selection as the tool result.

### Commands

Messages starting with `/` are classified on the host by `src/command-gate.ts` before they reach the container:

**Filtered commands (dropped entirely):**
- `/help`, `/login`, `/logout`, `/doctor`, `/config`, `/remote-control`
- Silently dropped — no error, no forwarding

**Admin-only commands (require admin sender):**
- `/clear` — clear session context
- `/compact` — force context compaction
- `/context`, `/cost`, `/files`
- If sent by a non-admin user, the command is rejected with a "Permission denied" message written straight to messages_out. Not forwarded to the agent.

**Other slash commands (pass-through to agent):**
- Passed to the container. The Claude provider handles slash commands natively, so they are sent raw, no XML wrapping

Admin verification happens host-side before the message ever reaches the container: `src/command-gate.ts` queries `user_roles` (owner / global admin / scoped-admin-of-this-agent-group). The container has no notion of admin identity — no env var, no DB query, no per-message check. Inside the container, `/clear` is handled by the agent-runner itself (it resets the stored SDK session); other commands go to the SDK.

### Recurring Tasks

The agent-runner processes recurring task messages like any other messages_in row. After a recurring message is `completed`, the **host** handles inserting the next occurrence (new messages_in row with `process_after` advanced to the next cron time). The agent-runner doesn't manage recurrence — it just processes what it finds.

Pre-scripts: if a task message has a `script` field, run it first. If `wakeAgent = false`, mark completed without invoking Claude.

### Agent-to-Agent Messaging

**Outbound:** Agent sends to a destination of type `agent` (via `send_message` or a `<message to="name">` block) → agent-runner writes messages_out with `channel_type: 'agent'`, `platform_id` = target agent group ID. Host validates permissions and writes to the target session's messages_in.

**Inbound:** Messages from other agents arrive as normal `chat` messages_in rows with `channel_type: 'agent'`. The formatter attributes them with the sending agent's destination name. No special formatting — the agent sees it as a chat message.

### Agent-Runner Properties

- AgentProvider interface wraps SDK-specific query logic (`container/agent-runner/src/providers/`: `claude`, plus `mock` for tests); providers self-register via `registerProvider()`
- Session resume via provider-specific mechanisms (SDK session ID persisted in `session_state`)
- System prompt loading from CLAUDE.md files
- PreCompact hook for transcript archiving (Claude provider)
- Script execution for task-kind messages

## Related Documents

- **[api-details.md](api-details.md)** — Channel adapter interface (NanoMika + Chat SDK bridge), message content examples, host delivery logic
- **[agent-runner-details.md](agent-runner-details.md)** — AgentProvider interface, MCP tools, message formatting, media handling, provider implementations
- **[writing-a-channel.md](writing-a-channel.md)** — How to add a channel adapter
