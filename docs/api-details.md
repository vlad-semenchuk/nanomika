# NanoMika API Details

Implementation-level details for the architecture. See [architecture.md](architecture.md) for the high-level design.

## Channel Adapter Interface

### NanoMika Channel Interface

Defined in `src/channels/adapter.ts` (abridged):

```typescript
interface ChannelSetup {
  // Host callbacks
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: InboundEvent): void | Promise<void>;   // admin transports (CLI): route to any wired channel
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;  // card button / question answer
}

interface ChannelAdapter {
  name: string;
  channelType: string;
  supportsThreads: boolean;   // true: one thread = one session; false: thread ids stripped at the router

  // Lifecycle
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // Outbound delivery — returns the platform message ID if available
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;

  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  resolveChannelName?(platformId: string): Promise<string | null>;
  subscribe?(platformId: string, threadId: string): Promise<void>;
  openDM?(userHandle: string): Promise<string>;
}

// Inbound message from adapter to host
interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown;       // JS object — host JSON.stringifies it before writing to the session DB
  timestamp: string;
  isMention?: boolean;    // platform-confirmed bot mention
  isGroup?: boolean;      // group/channel thread vs DM
}

// Outbound message from host to adapter
interface OutboundMessage {
  kind: string;
  content: unknown;       // parsed JSON from messages_out
  files?: OutboundFile[]; // { filename, data: Buffer } read from the session outbox
}
```

Adapters register themselves with `registerChannelAdapter(name, { factory })` (`src/channels/channel-registry.ts`); the barrel `src/channels/index.ts` imports each channel module for that side effect. A factory returns `null` when its credentials are missing, and the channel is skipped.

### Channel implementations

Channels implement the `ChannelAdapter` interface directly. The local CLI channel (`src/channels/cli.ts`, `channelType: 'cli'`, platform id `local`) is the in-tree example and the only channel imported by default:

- **Setup:** listens on the Unix socket `data/cli.sock`. The client `scripts/chat.ts` (`pnpm run chat <message>`) writes one JSON line per message (`{ "text": "..." }`) and reads JSON lines back. A line with `to` (and optional `reply_to`) is routed through `onInboundEvent` to any wired messaging group; otherwise the message goes through `onInbound` as `kind: 'chat'` with content `{ text, sender: 'cli', senderId: 'cli:local' }`.
- **Delivery:** writes `{ "text": ... }` to the connected client, or keeps it in a small backlog for the next client. `ask_question` cards are printed as text with numbered options.
- **Answers:** `/answer <questionId> <number|option>` is not routed to the agent; the adapter resolves the option and calls `onAction(questionId, value, 'cli:local')`.

## Session DB Schema Details

### messages_in content examples

**`chat`** — NanoMika chat format (what the CLI channel writes):
```json
{
  "sender": "cli",
  "senderId": "cli:local",
  "text": "Check this PR"
}
```

Optional fields the formatter reads: `attachments` (`[{ "type", "name", "url" | "localPath" }]`) and `replyTo` (`{ "id", "sender", "text" }`).

**`chat-sdk`** — the kind string is still accepted on inbound messages (the router, formatter and poll loop treat it like `chat`), but no channel in the tree produces it. In outbound rows it marks card and question messages (below).

Inbound attachments carrying base64 `data` are saved by the host to the session's `inbox/<messageId>/` directory and replaced with `"localPath": "inbox/<messageId>/<filename>"`.

**Question response** (`kind: 'system'`, written by the host when the user answers an `ask_user_question` card):
```json
{
  "type": "question_response",
  "questionId": "msg-1712345678-ab12cd",
  "selectedOption": "fix",
  "userId": "cli:local"
}
```

### messages_out content examples

**Normal chat message** (`kind: 'chat'`):
```json
{ "text": "LGTM, merging now" }
```

**Chat message with files** (files are in the session `outbox/<message id>/`):
```json
{ "text": "Here is the report", "files": ["report.pdf"] }
```

**Card** (`kind: 'chat-sdk'`, from `send_card`):
```json
{
  "type": "card",
  "card": {
    "title": "Deployment Status",
    "description": "Version 2.1.0 is live.",
    "children": ["All checks passed."]
  },
  "fallbackText": "Deployment Status: Version 2.1.0 is live."
}
```

**Ask user question** (`kind: 'chat-sdk'`, from `ask_user_question`):
```json
{
  "type": "ask_question",
  "questionId": "msg-1712345678-ab12cd",
  "title": "Failing Test",
  "question": "How should we handle the failing test?",
  "options": [
    { "label": "Skip it", "selectedLabel": "Skip it", "value": "Skip it" },
    { "label": "Fix and retry", "selectedLabel": "✅ Fixing", "value": "fix" },
    { "label": "Abort deployment", "selectedLabel": "❌ Aborted", "value": "abort" }
  ]
}
```

**Edit message** (`kind: 'chat'`; `messageId` is the platform message ID the host recorded at delivery):
```json
{ "operation": "edit", "messageId": "1712345678.000100", "text": "Updated: LGTM with minor comments on line 42" }
```

**Reaction** (`kind: 'chat'`):
```json
{ "operation": "reaction", "messageId": "1712345678.000100", "emoji": "thumbs_up" }
```

**System action** (`kind: 'system'`):
```json
{ "action": "cancel_task", "taskId": "msg-1712345678-ab12cd" }
```

Registered system actions: `schedule_task`, `cancel_task`, `pause_task`, `resume_task`, `update_task` (`src/modules/scheduling/`), `create_agent` (`src/modules/agent-to-agent/`), and `cli_request` (`src/cli/delivery-action.ts`, used by the in-container `ncl`).

## Host Delivery Logic

`src/delivery.ts` polls each session's `outbound.db` and dispatches every undelivered row in `deliverMessage()`:

```typescript
async function deliverMessage(msg, session, inDb) {
  const content = JSON.parse(msg.content);

  // System actions — handled by the action registered via registerDeliveryAction()
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — write to the target agent's session
  if (msg.channel_type === 'agent') {
    await routeAgentMessage(msg, session);
    return;
  }

  // Permission check: the origin chat is always allowed; any other messaging
  // group needs an agent_destinations row for this agent group.

  // ask_question → record in pending_questions

  // Channel delivery — read outbox files, then delegate to the adapter
  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type, msg.platform_id, msg.thread_id, msg.kind, msg.content, files,
  );
  clearOutbox(session.agent_group_id, session.id, msg.id);
  return platformMsgId;
}
```

The delivery adapter (`src/index.ts`) looks up the channel adapter by `channel_type` and calls its `deliver()`, which handles operation dispatch internally (post vs edit vs reaction vs card). A thrown error falls into the retry path and eventually marks the message failed.
