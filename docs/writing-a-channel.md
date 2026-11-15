# Writing a channel

A channel connects NanoMika to a place where messages come from: a chat platform, a webhook, a socket, a mail inbox. This guide adds a small working channel from scratch and then explains each part.

A channel is:

1. one file under `src/channels/` that implements the `ChannelAdapter` interface from [`src/channels/adapter.ts`](../src/channels/adapter.ts) and registers itself, and
2. one import line in [`src/channels/index.ts`](../src/channels/index.ts).

Nothing else in the host needs to change. The router, the sessions and the delivery loop are shared by all channels.

## The example: an HTTP channel

The example channel listens on `127.0.0.1:3080`.

- `POST /?chat=<chat>&from=<name>` with the message text as the body sends a message to the agent.
- `GET /?chat=<chat>` returns the replies for that chat as a JSON array and clears them.

Create `src/channels/http.ts`:

```ts
/**
 * HTTP channel: a minimal example adapter.
 *
 *   POST /?chat=<chat>&from=<name>   body = message text
 *   GET  /?chat=<chat>               returns and clears the replies for that chat
 */
import http from 'http';

import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PORT = 3080;

function createAdapter(): ChannelAdapter {
  let server: http.Server | null = null;
  // Replies waiting to be collected, by chat.
  const replies = new Map<string, string[]>();

  return {
    name: 'http',
    channelType: 'http',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const chat = url.searchParams.get('chat') ?? 'default';

        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(replies.get(chat) ?? []) + '\n');
          replies.delete(chat);
          return;
        }

        const from = url.searchParams.get('from') ?? 'anonymous';
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          void config.onInbound(chat, null, {
            id: `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            // Every request is addressed to the agent, so it counts as a mention.
            isMention: true,
            isGroup: false,
            content: { text: body.trim(), sender: from, senderId: `http:${from}` },
          });
          res.statusCode = 202;
          res.end('accepted\n');
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(PORT, '127.0.0.1', resolve);
      });
      log.info('HTTP channel listening', { port: PORT });
    },

    async teardown(): Promise<void> {
      server?.close();
      server = null;
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as { text?: unknown; markdown?: unknown } | undefined;
      const text = typeof content?.text === 'string' ? content.text : content?.markdown;
      // This example delivers plain text only. See "Outbound" below for the rest.
      if (typeof text !== 'string') return undefined;
      const queue = replies.get(platformId) ?? [];
      queue.push(text);
      replies.set(platformId, queue);
      return undefined;
    },
  };
}

registerChannelAdapter('http', { factory: createAdapter });
```

Add the import to `src/channels/index.ts`:

```ts
import './cli.js';
import './http.js';
```

Restart the host (`pnpm start`). The log shows `HTTP channel listening`.

## Connecting a chat to an agent

A message is routed only when its chat is known to the host and wired to an agent. There are two ways to get there.

### Way 1: answer the request in your terminal

Send a first message:

```bash
curl -X POST 'http://127.0.0.1:3080/?chat=demo&from=alice' -d 'hello'
```

The host has never seen the chat `demo` on the channel `http`. Because the message is flagged `isMention`, the host creates the chat and asks the owner what to do with it. The request arrives in your terminal:

```bash
pnpm run chat
```

```
[earlier] ❓ 💬 New direct message
alice sent your bot a DM on http. How would you like to handle it?
  1. Connect to Andy
  2. Connect new agent
  3. Reject
Answer with: pnpm run chat /answer mg-1763200000000-ab12cd <1-3>
```

Answer it:

```bash
pnpm run chat /answer mg-1763200000000-ab12cd 1
```

The host wires the chat to the agent, adds `http:alice` as a member of that agent, and routes the original message. Collect the reply a few seconds later:

```bash
curl 'http://127.0.0.1:3080/?chat=demo'
```

Option 3 marks the chat as denied. The host then ignores it until you wire it by hand.

### Way 2: wire it by hand with `ncl`

```bash
pnpm run ncl groups list          # find the agent group id (ag-…)

pnpm run ncl messaging-groups create \
  --channel-type http --platform-id demo2 --name "HTTP demo" \
  --unknown-sender-policy public

pnpm run ncl wirings create \
  --messaging-group-id <id printed by the previous command> \
  --agent-group-id <ag-…> \
  --engage-mode pattern --engage-pattern .
```

`--unknown-sender-policy public` lets any sender in that chat talk to the agent. `--engage-mode pattern --engage-pattern .` makes the agent answer every message. The `ncl` default is `mention`, which answers only messages flagged `isMention`.

`ncl wirings create` writes only the wiring. The agent can still reply to the chat a message came from. To let it start a conversation in that chat on its own, or to give the chat a readable name in the agent's prompt, also add a destination:

```bash
pnpm run ncl destinations add --agent-group-id <ag-…> --local-name demo2 \
  --target-type channel --target-id <messaging group id>
```

Way 1 creates that destination for you.

## How it works

### Registration

`registerChannelAdapter(name, { factory })` runs when the module is imported. At startup the host calls each factory, then `adapter.setup(config)`.

A factory may return `null`. The host then logs `Channel credentials missing, skipping` and carries on. Use this when the channel needs a token that is not set. Read tokens with `readEnvFile` from `src/env.ts`, as `src/channels/slack.ts` does, and add the variable to `.env.example`.

If `setup` throws, the host logs `Failed to start channel adapter` and starts without that channel. An error whose `name` is `NetworkError` is retried three times first.

### Inbound

Call `config.onInbound(platformId, threadId, message)` for every message that arrives.

| Argument | Meaning |
|---|---|
| `platformId` | The chat on your platform. With `channelType` it identifies the messaging group. Any stable string. |
| `threadId` | A thread inside the chat, or `null`. Ignored when `supportsThreads` is `false`. |
| `message.id` | A unique id for the message |
| `message.kind` | `'chat'` for an adapter you write yourself |
| `message.timestamp` | ISO 8601 |
| `message.content` | An object. The host stores it as JSON. See below. |
| `message.isMention` | `true` when the message is addressed to the agent: a direct message, or a mention in a group |
| `message.isGroup` | `true` for a group chat, `false` for a direct chat |

The fields of `content` that the host and the agent read:

| Field | Meaning |
|---|---|
| `text` | The message text |
| `sender` | Display name. The agent sees it as the author of the message. |
| `senderId` | The sender's identity. A value without `:` gets the channel type as a prefix, so `alice` on the `http` channel is the user `http:alice`. |

Without `senderId` the host uses `sender` as the identity. With neither, the sender is unknown and is refused in every chat that is not `public`.

`isMention` matters in two places:

- A message from a chat the host has never seen is ignored unless `isMention` is `true`. Only then does the owner get the request shown above.
- Wirings with engage mode `mention` or `mention-sticky` answer only messages with `isMention: true`.

### Outbound

The host calls `adapter.deliver(platformId, threadId, message)`. `message.content` is one of:

| Content | Meaning |
|---|---|
| `{ text }` or `{ markdown }` | A normal message |
| `{ type: 'ask_question', questionId, title, question, options }` | A question or approval request with choices |
| `{ type: 'card', card }` | A structured card |
| `{ operation: 'edit', messageId, text }` | Replace an earlier message |
| `{ operation: 'reaction', messageId, emoji }` | React to an earlier message |

`message.files`, when present, is a list of `{ filename, data }` attachments.

Return the platform's id for the message you sent, if it has one. The agent needs it to edit or react to that message later. Return `undefined` otherwise. An adapter may skip the content types it cannot show, as the example does. If `deliver` throws, the host retries the message and marks it failed after three attempts.

To support questions, show the options and, when the user picks one, call `config.onAction(questionId, optionValue, userId)`. `src/channels/cli.ts` does this in text form: it prints numbered options and turns `/answer <id> <n>` into an `onAction` call. `normalizeOptions` in `src/channels/ask-question.ts` turns the raw `options` into `{ label, value }` pairs.

### Optional methods

| Method | Use |
|---|---|
| `setTyping(platformId, threadId)` | Show a typing indicator while the agent works |
| `openDM(userHandle)` | Return the chat id of a direct chat with a user. Needed when the host must contact an owner or admin on your channel for an approval. Leave it out when the user handle is already the chat id. |
| `subscribe(platformId, threadId)` | Follow a thread after the first mention, for `mention-sticky` wirings |
| `resolveChannelName(platformId)` | Return a readable name for a chat |

### Who may talk to the agent

Each chat has an `unknown_sender_policy`:

| Policy | A sender the agent does not know |
|---|---|
| `public` | is accepted |
| `request_approval` | is held; the owner is asked to approve them. This is the policy of chats the host creates itself. |
| `strict` | is dropped |

A sender is known when they are a member of the agent group or hold a role:

```bash
pnpm run ncl members add --user http:alice --group <ag-…>
pnpm run ncl roles grant --user http:alice --role admin --group <ag-…>
```

Dropped messages are listed by `pnpm run ncl dropped-messages list`, with the reason.

## Using a Chat SDK adapter

For a platform that has a Chat SDK adapter (the `chat` package and its `@chat-adapter/*` packages) you do not write the adapter by hand. `createChatSdkBridge` in `src/channels/chat-sdk-bridge.ts` wraps the SDK adapter into a `ChannelAdapter`, including cards, buttons, threads, reactions and file uploads.

`src/channels/slack.ts` is the complete example in 41 lines: read the tokens, create the SDK adapter, pass it to the bridge, register. To add another platform the same way, add its adapter package with `pnpm add --save-exact <package>`, copy `slack.ts`, and add the import line.

## Checklist

- [ ] `src/channels/<name>.ts` implements `ChannelAdapter` and calls `registerChannelAdapter`
- [ ] The import is in `src/channels/index.ts`
- [ ] The factory returns `null` when credentials are missing
- [ ] Inbound content carries `text`, `sender` and `senderId`
- [ ] `isMention` is set for direct messages and mentions
- [ ] New variables are in `.env.example` and no secret is logged
- [ ] `pnpm run typecheck` and `pnpm test` pass
