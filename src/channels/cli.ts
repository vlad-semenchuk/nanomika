/**
 * CLI channel — talk to your agent from a local terminal via Unix socket.
 *
 * Always-on, zero-credentials channel that ships with main. The daemon
 * listens on `data/cli.sock`; the `scripts/chat.ts` client connects, writes
 * a JSON line per message, reads JSON lines back. The channel plumbs into
 * the normal router/delivery path like any other adapter — `/clear` and
 * other session-level commands work identically.
 *
 * Wire format: one JSON object per line.
 *
 *   Client → server:
 *     { "text": "user message" }                          # default — talk to cli/local
 *     { "text": "...", "to": {"channelType": "discord",
 *                             "platformId": "discord:@me:149...",
 *                             "threadId": null} }         # route to a specific mg
 *     { "text": "...", "to": {...}, "reply_to": {...} }   # + redirect replies
 *   Server → client:
 *     { "text": "agent reply" }
 *
 * Questions and approval requests (`ask_question` cards) are printed as text
 * with numbered options. Answer one with `/answer <questionId> <number|option>`;
 * the adapter turns that into an action from `cli:local` instead of routing
 * it to the agent.
 *
 * The `to` and `reply_to` addressing is how admin transports (the bootstrap
 * script) inject messages targeting any wired channel. `reply_to` is a
 * router-layer concept — agents cannot set it; it is carried only on
 * inbound events from CLI clients that hold operator privilege (the socket
 * is chmod 0600, so "connected to this socket" ≈ "is the owner").
 *
 * Single-client chat semantics: one connected terminal at a time. A second
 * "chat" connection closes the first with a "superseded" notice. Admin
 * route-opcode connections (`to` set) are one-shot and do NOT evict an
 * active chat client.
 *
 * deliver() silently no-ops when no client is connected. The outbound row
 * is already in outbound.db, so the message isn't lost — it just doesn't
 * reach this run's terminal. Reconnect to see subsequent replies.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, DeliveryAddress, InboundEvent, OutboundMessage } from './adapter.js';
import { normalizeOptions, type NormalizedOption, type RawOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';

const PLATFORM_ID = 'local';

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;
  // Options of questions printed to the terminal, so `/answer <id> 2` can map
  // a number or label back to the option value. In memory only.
  const pendingQuestions = new Map<string, NormalizedOption[]>();

  const adapter: ChannelAdapter = {
    name: 'cli',
    channelType: 'cli',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();

      // Stale socket cleanup: a previous run that crashed may have left the
      // file behind, and net.createServer refuses to bind to an existing path.
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          log.warn('Failed to unlink stale CLI socket (will try to bind anyway)', { sock, err });
        }
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          // Tighten perms so only the owner can connect. Unix socket files
          // obey filesystem perms — 0700 on the socket means other local
          // users can't send into this agent.
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
          }
          log.info('CLI channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.end();
        } catch {
          // swallow — teardown is best-effort
        }
        client = null;
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      // Remove the socket file so a relaunch doesn't trip over it.
      try {
        fs.unlinkSync(socketPath());
      } catch {
        // swallow
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      if (!client) {
        // No live terminal — outbound row is already persisted, so this
        // isn't a data loss. User will see it on the next connect cycle
        // (or never, if we don't add scroll-back). Not worth throwing.
        return undefined;
      }
      const question = asQuestion(message);
      if (question) pendingQuestions.set(question.questionId, question.options);
      const text = question ? formatQuestionText(question) : extractText(message);
      if (text === null) return undefined;
      try {
        client.write(JSON.stringify({ text }) + '\n');
      } catch (err) {
        log.warn('Failed to write to CLI client', { err });
      }
      return undefined;
    },
  };

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    // Defer the chat-slot swap until we see the first line — if it turns out
    // to be a routed (`to`-bearing) one-shot, we leave the existing chat
    // client in place. Only plain chat connections participate in supersede.
    let claimedChatSlot = false;

    const claimChatSlot = () => {
      if (claimedChatSlot) return;
      claimedChatSlot = true;
      if (client && client !== socket) {
        try {
          client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
          client.end();
        } catch {
          // swallow
        }
      }
      client = socket;
      log.info('CLI client connected');
    };

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, config, claimChatSlot);
      }
    });

    socket.on('close', () => {
      if (client === socket) client = null;
      if (claimedChatSlot) log.info('CLI client disconnected');
    });

    socket.on('error', (err) => {
      log.warn('CLI client socket error', { err });
    });
  }

  async function handleLine(line: string, config: ChannelSetup, claimChatSlot: () => void): Promise<void> {
    let payload: {
      text?: unknown;
      to?: unknown;
      reply_to?: unknown;
      sender?: unknown;
      senderId?: unknown;
    };
    try {
      payload = JSON.parse(line);
    } catch (err) {
      log.warn('CLI: ignoring non-JSON line from client', { line });
      return;
    }
    if (typeof payload.text !== 'string' || payload.text.length === 0) return;

    const to = parseAddress(payload.to);
    const replyTo = parseAddress(payload.reply_to);

    if (to) {
      // Routed message — admin transport. Build a full InboundEvent targeting
      // `to`'s channel/platform, and let `reply_to` (if any) redirect replies.
      // Does NOT claim the chat slot, so an active terminal chat isn't evicted.
      const event: InboundEvent = {
        channelType: to.channelType,
        platformId: to.platformId,
        threadId: to.threadId,
        message: {
          id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            text: payload.text,
            sender: typeof payload.sender === 'string' ? payload.sender : 'cli',
            senderId: typeof payload.senderId === 'string' ? payload.senderId : `cli:${PLATFORM_ID}`,
          }),
        },
        replyTo: replyTo ?? undefined,
      };
      try {
        await config.onInboundEvent(event);
      } catch (err) {
        log.error('CLI: onInboundEvent threw', { err });
      }
      return;
    }

    // Plain chat — claim the slot (evicting any prior client) and route via
    // the standard onInbound path (adapter injects its own channelType).
    claimChatSlot();

    const answer = parseAnswerCommand(payload.text);
    if (answer) {
      const options = pendingQuestions.get(answer.questionId);
      // Options unknown (e.g. the host restarted since the question was
      // printed): accept an option name, never a bare number.
      const value = options
        ? resolveOption(options, answer.choice)
        : /^\d+$/.test(answer.choice)
          ? null
          : answer.choice.toLowerCase();
      if (value === null) {
        reply(`[unknown option "${answer.choice}" for ${answer.questionId}; answer with an option name]`);
        return;
      }
      pendingQuestions.delete(answer.questionId);
      config.onAction(answer.questionId, value, `cli:${PLATFORM_ID}`);
      reply(`[answered ${answer.questionId}: ${value}]`);
      return;
    }

    try {
      await config.onInbound(PLATFORM_ID, null, {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: payload.text,
          sender: 'cli',
          senderId: `cli:${PLATFORM_ID}`,
        },
      });
    } catch (err) {
      log.error('CLI: onInbound threw', { err });
    }
  }

  function reply(text: string): void {
    try {
      client?.write(JSON.stringify({ text }) + '\n');
    } catch (err) {
      log.warn('Failed to write to CLI client', { err });
    }
  }

  function parseAddress(raw: unknown): DeliveryAddress | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.channelType !== 'string' || typeof obj.platformId !== 'string') return null;
    const threadId =
      obj.threadId === null || obj.threadId === undefined
        ? null
        : typeof obj.threadId === 'string'
          ? obj.threadId
          : null;
    return {
      channelType: obj.channelType,
      platformId: obj.platformId,
      threadId,
    };
  }

  return adapter;
}

interface CliQuestion {
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}

function asQuestion(message: OutboundMessage): CliQuestion | null {
  const c = message.content as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object' || c.type !== 'ask_question') return null;
  if (typeof c.questionId !== 'string' || !Array.isArray(c.options)) return null;
  return {
    questionId: c.questionId,
    title: typeof c.title === 'string' ? c.title : 'Question',
    question: typeof c.question === 'string' ? c.question : '',
    options: normalizeOptions(c.options as RawOption[]),
  };
}

/** Render an ask_question card as plain text for the terminal. */
export function formatQuestionText(q: CliQuestion): string {
  const lines = [`❓ ${q.title}`];
  if (q.question) lines.push(q.question);
  q.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}`));
  lines.push(`Answer with: pnpm run chat /answer ${q.questionId} <1-${q.options.length}>`);
  return lines.join('\n');
}

/** Parse `/answer <questionId> <choice>`; null for any other text. */
export function parseAnswerCommand(text: string): { questionId: string; choice: string } | null {
  const m = text.trim().match(/^\/answer\s+(\S+)\s+(.+)$/);
  return m ? { questionId: m[1], choice: m[2].trim() } : null;
}

/** Map a 1-based number, a label or a value to the option value. */
export function resolveOption(options: NormalizedOption[], choice: string): string | null {
  if (/^\d+$/.test(choice)) {
    const o = options[Number(choice) - 1];
    return o ? o.value : null;
  }
  const lc = choice.toLowerCase();
  const o = options.find((x) => x.value.toLowerCase() === lc || x.label.toLowerCase() === lc);
  return o ? o.value : null;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('cli', { factory: createAdapter });
