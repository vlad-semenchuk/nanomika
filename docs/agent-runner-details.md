# NanoMika Agent-Runner Details

Implementation-level details for the agent-runner inside the container (`container/agent-runner/src/`). See [architecture.md](architecture.md) for the high-level design.

## Separation of Concerns

The agent-runner has two layers:

1. **Agent-runner core** — owns the poll loop, message formatting, DB reads/writes, MCP tool implementations, routing, status management, and pre-task scripts. This is NanoMika-specific and shared across all providers.

2. **Agent provider** — owns the SDK interaction. Takes formatted prompts, pushes them to the SDK, yields events back. The image ships the `claude` provider (`providers/claude.ts`) plus a `mock` provider used by tests (`providers/mock.ts`).

The boundary: the agent-runner decides **what** to send and **what to do** with results. The provider decides **how** to talk to the SDK.

## AgentProvider Interface

From `providers/types.ts`:

```typescript
interface AgentProvider {
  /** True if the SDK handles slash commands natively and wants them as raw text. */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /** True if the error means the stored continuation is invalid and should be cleared. */
  isSessionInvalid(err: unknown): boolean;

  /** Optional: return a reason string to drop the continuation and start fresh. */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  model?: string;   // alias (sonnet, opus, haiku) or full model ID
  effort?: string;  // 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /** Opaque continuation token from a previous query (session ID for Claude). */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /** System context to inject. */
  systemContext?: { instructions?: string };
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentQuery {
  /** Push a follow-up message into the active query */
  push(message: string): void;

  /** Signal that no more input will be sent */
  end(): void;

  /** Output event stream */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query */
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' };
```

Provider-level settings (MCP servers, env, additional directories, model, effort) are passed once to the provider constructor as `ProviderOptions`; `QueryInput` carries only per-query data.

### What the interface does NOT include

- **Message formatting** — the agent-runner formats messages before passing to the provider. The provider receives a ready-to-send prompt string.
- **Hooks** — Claude-specific. The Claude provider registers its hooks internally (PreToolUse, PostToolUse, PostToolUseFailure, PreCompact).
- **Tool allowlists** — the Claude provider configures `allowedTools` / `disallowedTools` internally.
- **Session persistence** — Claude persists sessions to disk automatically. The agent-runner only stores and passes back the opaque `continuation`.

### Provider event semantics

- **`init`** — emitted when the provider establishes or resumes a session. The agent-runner stores `continuation` immediately (see Session Resume).
- **`result`** — emitted when the agent produces a complete response. May be emitted multiple times per query (e.g., multi-turn with subagents, or a context-compaction notice). The agent-runner parses each result for `<message to="...">` blocks and writes them to messages_out.
- **`error`** — logged. `retryable` and `classification` (e.g., `'quota'`) are informational.
- **`progress`** — logged only.
- **`activity`** — liveness signal emitted on every underlying SDK event, so the heartbeat stays fresh during long tool runs.

## Claude Provider

`providers/claude.ts` wraps `@anthropic-ai/claude-agent-sdk`'s `query()`:

```typescript
sdkQuery({
  prompt: stream,                       // MessageStream: push-based AsyncIterable
  options: {
    cwd: input.cwd,
    additionalDirectories: this.additionalDirectories,
    resume: input.continuation,
    pathToClaudeCodeExecutable: '/pnpm/claude',
    systemPrompt: instructions
      ? { type: 'preset', preset: 'claude_code', append: instructions }
      : undefined,
    allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(this.mcpServers).map(mcpAllowPattern)],
    disallowedTools: SDK_DISALLOWED_TOOLS,
    env: this.env,
    model: this.model,
    effort: this.effort,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user', 'local'],
    mcpServers: this.mcpServers,
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook] }],
      PostToolUse: [{ hooks: [postToolUseHook] }],
      PostToolUseFailure: [{ hooks: [postToolUseHook] }],
      PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
    },
  },
});
```

The async generator inside `query()` maps SDK messages to `ProviderEvent`:
- every SDK message → `{ type: 'activity' }`
- `message.type === 'system' && message.subtype === 'init'` → `{ type: 'init', continuation: session_id }`
- `message.type === 'result'` → `{ type: 'result', text }`
- `message.type === 'system' && message.subtype === 'api_retry'` → `{ type: 'error', retryable: true }`
- `message.type === 'system' && message.subtype === 'rate_limit_event'` → `{ type: 'error', retryable: false, classification: 'quota' }`
- `message.type === 'system' && message.subtype === 'compact_boundary'` → `{ type: 'result', text: 'Context compacted (...)' }`
- `message.type === 'system' && message.subtype === 'task_notification'` → `{ type: 'progress', message }`

**Claude-specific behavior inside the provider:**
- `MessageStream` for async iterable input (push-based), so the CLI stays alive across follow-ups
- `TOOL_ALLOWLIST` of SDK built-ins plus `mcp__<server>__*` for every configured MCP server
- `SDK_DISALLOWED_TOOLS`: `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree` (NanoMika has its own scheduling and question tools; the rest are interactive-UI affordances). The PreToolUse hook also blocks them as a second line of defense.
- PreToolUse / PostToolUse hooks record the in-flight tool (and a Bash call's declared timeout) in the `container_state` table of `outbound.db`, so the host sweep can tolerate long-running tools
- PreCompact hook archives the transcript to `conversations/`
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (default `165000`) set in the SDK env
- `isSessionInvalid()` matches "no conversation found" / missing `.jsonl` / "session not found" errors
- `maybeRotateContinuation()` drops a session whose transcript exceeds `CLAUDE_TRANSCRIPT_ROTATE_BYTES` (default 12 MB) or is older than `CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS` (default 14), archiving a summary first

## Agent-Runner Core

Everything below is handled by the agent-runner, not the provider.

### Poll Loop

`poll-loop.ts`, `runPollLoop()`:

```
┌──────────────────────────────────────────────┐
│                                              │
│  1. getPendingMessages(): messages_in rows   │
│     WHERE status = 'pending'                 │
│     AND (process_after IS NULL               │
│          OR process_after <= now())          │
│     minus ids already in processing_ack;     │
│     kind = 'system' rows are skipped         │
│                                              │
│  2. If no row has trigger = 1: sleep, retry  │
│                                              │
│  3. Otherwise:                               │
│     a. markProcessing (processing_ack)       │
│     b. Handle /clear                         │
│     c. Run pre-task scripts                  │
│     d. Format messages                       │
│     e. provider.query(prompt)                │
│     f. Process provider events               │
│     g. Write results to messages_out         │
│     h. markCompleted (processing_ack)        │
│                                              │
│  4. While query is active:                   │
│     - Poll messages_in every 500ms           │
│     - New messages → provider.push()         │
│                                              │
│  5. When query finishes: back to step 1      │
│                                              │
└──────────────────────────────────────────────┘
```

**Concurrent polling during active query:** While the provider is running a query, the agent-runner keeps polling messages_in every 500ms. New pending messages (after their pre-task scripts) are formatted and pushed into the active query via `query.push()`. The stream is not closed on silence; liveness is decided host-side via the heartbeat file and processing-claim age (`src/host-sweep.ts`). If a pending message is a slash command (`isRunnerCommand`), the runner ends the stream instead so the outer loop can handle the command as the first input of a fresh query.

**Idle behavior:** When no messages are pending and no query is active, the agent-runner sleeps 1s and re-polls. The container stays warm until the host stops it.

**Liveness:** `touchHeartbeat()` touches `/workspace/.heartbeat` on every provider event and around pre-task scripts. The in-flight tool recorded in `container_state` lets the host sweep widen its tolerance while a long Bash command runs.

**Corruption guard:** If the follow-up poll hits 10 consecutive SQLite corruption errors (a cross-mount page-cache issue), the process exits with code 75 so the host respawns the container with a fresh mount.

### Message Formatting

`formatter.ts` transforms messages_in rows into a prompt string. The provider receives a ready-to-send string — it doesn't know about message kinds or routing.

Every prompt starts with a timezone header:

```xml
<context timezone="America/Los_Angeles" />
```

**Routing field stripping:** `platform_id`, `channel_type`, `thread_id` are never included in the prompt. Instead, each block carries a `from="<destination name>"` attribute resolved from the local destinations table (or `from="unknown:<channel_type>:<platform_id>"`).

**Formatting by kind:**

- **`chat` / `chat-sdk`** — one `<message>` element per row; `id` is the row's `seq`:
  ```xml
  <message id="7" from="local" sender="John" time="2024-01-01 10:00">Check this PR
  [image: screenshot.png — saved to /workspace/inbox/msg-123/screenshot.png]</message>
  ```
  Replies add a `reply_to` attribute and an inline `<quoted_message from="...">` when the quoted sender and text are known. Attachments are listed inline (see Media Handling).

- **`task`** — task prompt, optionally with script output:
  ```xml
  <task from="local" time="...">Script output:
  {"data": ...}

  Instructions:
  Review open PRs</task>
  ```

- **`webhook`**:
  ```xml
  <webhook from="..." source="github" event="pull_request">{ ...payload... }</webhook>
  ```

- **`system`** — rendered as `<system_response action="..." status="...">`. In practice the poll loop filters `system` rows out (they are responses consumed by MCP tools such as `ask_user_question`).

**Batch formatting:** Multiple pending messages are combined into one prompt: the header, then all chat messages (one `<message>` per line, no outer wrapper), then tasks, webhooks and system blocks separated by blank lines.

**Command detection:** `categorizeMessage()` classifies messages starting with `/`. `/clear` is handled by the runner itself: it clears the stored continuation and replies "Session cleared." For providers with `supportsNativeSlashCommands` (Claude), other admin commands (`/compact`, `/context`, `/cost`, `/files`) and unknown commands are passed raw to the SDK instead of XML-wrapped. Filtering and admin-permission gating happen on the host (`src/command-gate.ts`) before messages reach the container.

### Output and Routing

The agent's final text must wrap deliverable content in `<message to="name">...</message>` blocks; `name` is a destination from the `destinations` table in `inbound.db` (written by the host on every wake). Text outside these blocks, and `<internal>...</internal>`, is scratchpad: logged, not sent. If a result has text but no `<message>` blocks, the runner pushes a one-time `<system>` reminder into the query asking the agent to re-send with correct wrapping.

For each block the runner writes a `messages_out` row with `kind: 'chat'`. For a channel destination it uses the destination's `channel_type` / `platform_id`; for an agent destination `channel_type: 'agent'` and `platform_id: <agent group id>`. `thread_id` and `in_reply_to` come from the most recent inbound message from that same channel and platform.

The batch's routing context (`extractRouting()`, taken from the first message) is:

```typescript
interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;  // messages_in.id of the first message in the batch
}
```

It is used for runner-generated replies ("Session cleared.", `Error: ...`). `inReplyTo` is also published via `current-batch.ts` so MCP tools stamp it on their outbound rows.

### Status Management

The container never writes `inbound.db`. Processing status lives in the `processing_ack` table of `outbound.db`:

```
pending → processing → completed
```

- **Pick up:** `markProcessing(ids)` → `INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))`
- **Complete:** `markCompleted(ids)` — the initial batch is marked completed as soon as the first `result` event arrives, and again after the query ends.
- **Error:** the runner writes an `Error: <message>` chat reply and marks the batch completed; if `provider.isSessionInvalid(err)` it also clears the stored continuation.
- **Startup:** `clearStaleProcessingAcks()` deletes leftover `processing` rows from a previous crashed container.

The host sweep (`src/host-sweep.ts`) syncs `processing_ack` back into `messages_in.status` and handles retries: messages stuck in `processing` are reset to `pending` with backoff and `tries++`, and marked failed after the maximum number of tries.

### MCP Tools

The agent-runner starts an MCP server named `nanomika` (`mcp-tools/index.ts`, run with `bun run`) over stdio. Each tool module calls `registerTools([...])` at import time; the barrel imports `core.ts`, `scheduling.ts`, `interactive.ts` and `agents.ts`. Tools write to `outbound.db` and read `inbound.db` at the fixed mount paths. The agent sees them as `mcp__nanomika__<tool>`.

| Tool | Module | Parameters |
|------|--------|------------|
| `send_message` | `core.ts` | `text`, `to?` |
| `send_file` | `core.ts` | `path`, `to?`, `text?`, `filename?` |
| `edit_message` | `core.ts` | `messageId` (integer), `text` |
| `add_reaction` | `core.ts` | `messageId` (integer), `emoji` |
| `ask_user_question` | `interactive.ts` | `title`, `question`, `options`, `timeout?` |
| `send_card` | `interactive.ts` | `card`, `fallbackText?` |
| `schedule_task` | `scheduling.ts` | `prompt`, `processAfter`, `recurrence?`, `script?` |
| `list_tasks` | `scheduling.ts` | `status?` |
| `cancel_task` | `scheduling.ts` | `taskId` |
| `pause_task` | `scheduling.ts` | `taskId` |
| `resume_task` | `scheduling.ts` | `taskId` |
| `update_task` | `scheduling.ts` | `taskId`, `prompt?`, `recurrence?`, `processAfter?`, `script?` |
| `create_agent` | `agents.ts` | `name`, `instructions?` |

Agent-facing usage notes for each module live next to the code in `mcp-tools/*.instructions.md`; the host composes them into the agent's `CLAUDE.md`.

#### send_message

Send a chat message to a named destination. Without `to`, the message goes to the session's default reply routing (the `session_routing` table in `inbound.db`, i.e. the conversation and thread the session is bound to); if there is no session routing and exactly one destination exists, that destination is used.

Implementation: write a `messages_out` row with `kind: 'chat'`, content `{ text }`, and `in_reply_to` from the current batch. When `to` names the same channel the session is bound to, the session's `thread_id` is kept; otherwise `thread_id` is null. Agent destinations route with `channel_type: 'agent'`.

#### send_file

Send a file to a destination (same `to` resolution as `send_message`).

Implementation:
1. Generate a message ID
2. Create `/workspace/outbox/{messageId}/`
3. Copy the file (relative paths resolve against `/workspace/agent/`) into the outbox directory
4. Write a `messages_out` row with content `{ text, files: [filename] }`

The host reads the files from the session outbox at delivery time and passes them to the adapter.

#### edit_message / add_reaction

Edit a previously sent message, or react to a message. `messageId` is the integer `id` (seq) shown to the agent. The tool looks up the platform message ID and routing for that seq and writes a `messages_out` row with `kind: 'chat'` and content `{ operation: 'edit', messageId, text }` or `{ operation: 'reaction', messageId, emoji }`.

#### ask_user_question

Send a multiple-choice question and wait for the answer. This is a **blocking tool call** — the tool doesn't return until the user responds or the timeout (default 300s) expires. Options may be strings or `{ label, selectedLabel?, value? }`.

Implementation:
1. Generate a `questionId`
2. Write a `messages_out` row with `kind: 'chat-sdk'` and content `{ type: 'ask_question', questionId, title, question, options }`, routed to the session's default routing
3. Poll `inbound.db` every second for a pending row whose content contains the `questionId` (the host writes a `system` row with `{ type: 'question_response', questionId, selectedOption, userId }`)
4. When found, mark it completed and return `selectedOption` as the tool result
5. If the timeout expires, return an error result

On the host, delivery records the question in `pending_questions`; the channel renders it (the CLI channel prints numbered text options, answered with `pnpm run chat /answer <questionId> <number|option>`).

#### send_card

Write a `messages_out` row with `kind: 'chat-sdk'` and content `{ type: 'card', card, fallbackText }`. Display-only: no response flow.

#### schedule_task

Write a `messages_out` row with `kind: 'system'` and `action: 'schedule_task'`. `processAfter` accepts UTC or a naive local timestamp (interpreted in the container's `TZ`); `recurrence` is a cron expression evaluated in the same timezone. The host's scheduling module (`src/modules/scheduling/`) inserts the `task` row into `inbound.db`; the host sweep wakes the container when it is due and creates the next occurrence of recurring tasks.

#### list_tasks

Read `inbound.db` directly: one row per `series_id` for `kind = 'task'` with status `pending` or `paused` (or only the given `status`), showing the series id, status, next run, recurrence and prompt.

#### cancel_task / pause_task / resume_task / update_task

Each writes a `kind: 'system'` row (`action: 'cancel_task'` etc.); the host applies it to `inbound.db` (`src/modules/scheduling/db.ts`). `update_task` merges the supplied fields into the live row; an empty string clears `recurrence` or `script`. All four match by `(id = ? OR series_id = ?) AND kind = 'task'` on rows that are still live, so they reach the next occurrence of a recurring task even when the agent passes the original (now-completed) id.

#### create_agent

Write a `kind: 'system'` row with `action: 'create_agent'`, `name` and `instructions`. The host's agent-to-agent module (`src/modules/agent-to-agent/create-agent.ts`) creates the agent group and its folder, wires destinations in both directions, refreshes the parent's destinations, and notifies the parent with a chat message when done.

### Media Handling

#### Inbound (messages_in → agent prompt)

The host saves inbound attachments that arrive as base64 data into the session's `inbox/{messageId}/` directory and replaces the data with a `localPath` (`src/session-manager.ts`). The formatter lists each attachment inline:

```
[image: screenshot.png — saved to /workspace/inbox/msg-123/screenshot.png]
[file: report.pdf (https://...)]
```

Attachments without a local file are listed with their URL if one is present. The agent uses tools (Read, Bash) to access saved files. The prompt is always a plain string; there is no content-block construction.

#### Outbound (agent → messages_out)

Handled via the `send_file` MCP tool (see above). The agent explicitly decides to send a file — the agent-runner doesn't scan output for file references.

### Pre-Agent Scripts (Tasks)

`scheduling/task-script.ts`, `applyPreTaskScripts()`, runs for `task` messages whose content has a `script` field, for both the initial batch and follow-ups:

1. Write the script to `/tmp/task-script-<taskId>.sh`
2. Execute with `bash` (30s timeout)
3. Parse the last line of stdout as JSON: `{ wakeAgent: boolean, data?: unknown }`
4. If `wakeAgent === false`, or the script errors or prints no valid JSON: mark that task completed, don't send it to the provider
5. If `wakeAgent === true`: store `data` as `scriptOutput` in the task content, which the formatter renders into the prompt

Other messages in the same batch are unaffected.

### Transcript Archiving

The Claude provider archives conversation transcripts via the PreCompact hook, and before rotating an oversized session. The archive is a Markdown summary of the user/assistant text.

Archive location: `/workspace/agent/conversations/{date}-{summary}.md` (overridable with `NANOMIKA_CONVERSATIONS_DIR`).

Separately, `compact-instructions.ts` prints compaction instructions (preserve message XML and destination names) for a PreCompact command hook configured in the group's Claude settings.

### Session Resume

The continuation (Claude session ID) is stored per provider in the `session_state` table of `outbound.db` under the key `continuation:<provider>`:

- On startup, `getContinuation()` loads it, then `maybeRotateContinuation()` may drop it.
- On each `init` event it is saved immediately, so a mid-turn crash still resumes on the next wake.
- `/clear` and an invalid-session error clear it.

Because `outbound.db` lives in the session folder on the host, the continuation survives container restarts.

### Container Startup

`index.ts` reads its configuration from:

- **`/workspace/agent/container.json`** (read-only mount, written by the host from the group's `container_configs` row): `provider` (default `claude`), `assistantName`, `maxMessagesPerPrompt`, `mcpServers`, `model`, `effort`. Loaded by `config.ts`.
- **Environment:** only variables read by code NanoMika doesn't own: `TZ`, `ANTHROPIC_BASE_URL` (pointing at the host credential proxy) with a placeholder `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and any provider-contributed env. The real credential never enters the container.
- **Fixed mount paths:** `/workspace/inbound.db`, `/workspace/outbound.db`, `/workspace/outbox/`, `/workspace/agent/` (agent group folder), `/app/src/` (agent-runner source, RO), `/app/skills/` (container skills, RO), `/app/CLAUDE.md` (shared base instructions, RO), `/home/node/.claude/` (per-group Claude state). Optional extra mounts appear under `/workspace/extra/*`.

Startup steps:
1. Build the system-prompt addendum (`buildSystemPromptAddendum()` in `destinations.ts`): agent name plus the live destinations list. Everything else is loaded by Claude Code from `/workspace/agent/CLAUDE.md`, which the host composes on every spawn from `/app/CLAUDE.md`, skill fragments and MCP-tool instruction fragments; per-group memory is `/workspace/agent/CLAUDE.local.md`.
2. Discover additional directories under `/workspace/extra/*`.
3. Build `mcpServers`: the built-in `nanomika` server (`bun run mcp-tools/index.ts`) plus any servers from `container.json`.
4. Create the provider and enter the poll loop.

No stdin, no initial prompt — messages are already in the session DB.

### Provider Factory

```typescript
type ProviderName = string;

function createProvider(name: ProviderName, options: ProviderOptions = {}): AgentProvider {
  return getProviderFactory(name)(options);
}
```

Each provider module calls `registerProvider(name, factory)` at top level (`providers/provider-registry.ts`); the barrel `providers/index.ts` imports every provider module for that side effect. `getProviderFactory()` throws `Unknown provider: <name>. Registered: ...` for an unregistered name.

## Agent-Runner Properties

- Runs on Bun directly from TypeScript source (`exec bun run /app/src/index.ts`); no build step in the image
- The MCP server is a separate Bun process spawned by the SDK from the `mcpServers` config
- The MCP server binary is shared across providers — same tools, same DB access
- Additional directories discovery (`/workspace/extra/*`)
- In-container `ncl` (`cli/ncl.ts`) uses the session DBs as transport: it writes a `cli_request` system message and polls for the response
- Logging via stderr (`[agent-runner] ...`, `[poll-loop] ...`, `[mcp-tools] ...`)

## Related Documents

- **[architecture.md](architecture.md)** — High-level architecture (session DB schema, central DB, channel adapters, message flow)
- **[api-details.md](api-details.md)** — Channel adapter interface, message content examples, host delivery logic
