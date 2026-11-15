import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelSetup } from './adapter.js';

const hoisted = vi.hoisted(() => ({
  registered: new Map<string, { factory: () => unknown }>(),
  env: {} as Record<string, string>,
  setupConfig: undefined as unknown as ChannelSetup,
}));

vi.mock('../env.js', () => ({ readEnvFile: () => hoisted.env }));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (name: string, reg: { factory: () => unknown }) => hoisted.registered.set(name, reg),
}));
// Keep the real bridge for delivery, but capture the config passed to setup()
// so no Chat instance, database or polling loop starts.
vi.mock('./chat-sdk-bridge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./chat-sdk-bridge.js')>();
  return {
    ...real,
    createChatSdkBridge: (config: Parameters<typeof real.createChatSdkBridge>[0]) => {
      const bridge = real.createChatSdkBridge(config);
      bridge.setup = async (c) => {
        hoisted.setupConfig = c;
      };
      return bridge;
    },
  };
});

import { gateCommand } from '../command-gate.js';
import { createTelegramChannel, stripBotSuffix } from './telegram.js';

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

function stubTelegramApi(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body?: string }) => {
      const method = String(url).split('/').pop() as string;
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      sent.push({ method, body });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: sent.length, chat: { id: 42, type: 'private' }, date: 1, text: 'x' },
        }),
      );
    }),
  );
  return sent;
}

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_USERNAME', 'mikabot');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  hoisted.env = {};
});

describe('telegram registration', () => {
  it('registers under "telegram"', () => {
    expect(hoisted.registered.has('telegram')).toBe(true);
  });

  it('returns null without TELEGRAM_BOT_TOKEN', () => {
    hoisted.env = {};
    expect(hoisted.registered.get('telegram')!.factory()).toBeNull();
  });

  it('builds a non-threaded telegram adapter when the token is set', () => {
    hoisted.env = { TELEGRAM_BOT_TOKEN: '123:abc' };
    const adapter = hoisted.registered.get('telegram')!.factory() as ReturnType<typeof createTelegramChannel>;
    expect(adapter.channelType).toBe('telegram');
    expect(adapter.supportsThreads).toBe(false);
  });
});

describe('stripBotSuffix', () => {
  it("drops this bot's suffix and keeps the arguments", () => {
    expect(stripBotSuffix('/clear@MikaBot', 'mikabot')).toBe('/clear');
    expect(stripBotSuffix('/context@mikabot now', 'mikabot')).toBe('/context now');
  });

  it('leaves other bots, plain text and mentions alone', () => {
    expect(stripBotSuffix('/clear@otherbot', 'mikabot')).toBe('/clear@otherbot');
    expect(stripBotSuffix('hello /clear@mikabot', 'mikabot')).toBe('hello /clear@mikabot');
    expect(stripBotSuffix('@mikabot hi', 'mikabot')).toBe('@mikabot hi');
  });
});

describe('telegram inbound', () => {
  async function inbound(text: string) {
    const onInbound = vi.fn(async () => {});
    await createTelegramChannel('123:abc').setup({ onInbound } as unknown as ChannelSetup);
    const content = { text };
    await hoisted.setupConfig.onInbound('telegram:-100', null, { kind: 'chat-sdk', content } as never);
    expect(onInbound).toHaveBeenCalledOnce();
    return (onInbound.mock.calls[0] as unknown as [string, string | null, { content: { text: string } }])[2].content
      .text;
  }

  it('lets the command gate see group commands addressed to the bot', async () => {
    const text = await inbound('/clear@mikabot');
    expect(text).toBe('/clear');
    // No sender: the gate denies admin commands. With the suffix left on, it would pass.
    expect(gateCommand(JSON.stringify({ text }), null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
    expect(gateCommand(JSON.stringify({ text: '/clear@mikabot' }), null, 'ag-1')).toEqual({ action: 'pass' });
  });

  it('keeps filtered commands filtered', async () => {
    const text = await inbound('/help@mikabot');
    expect(gateCommand(JSON.stringify({ text }), null, 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('telegram delivery', () => {
  it('keeps every button callback_data within 64 bytes for real approval ids', async () => {
    const sent = stubTelegramApi();
    const channel = createTelegramChannel('123:abc');
    await channel.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-1763200000000-ab12cd',
        title: 'Approval',
        question: 'Run it?',
        // Long values must not reach callback_data.
        options: [
          { label: 'Approve', value: 'https://example.com/' + 'x'.repeat(200) },
          { label: 'Reject', value: '2025-01-01T00:00:00.000Z-' + 'y'.repeat(100) },
        ],
      },
    });
    const message = sent.find((s) => s.method === 'sendMessage')!;
    const keyboard = (message.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const buttons = keyboard.flat();
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('splits a long reply into several messages under the 4096 limit instead of cutting it', async () => {
    const sent = stubTelegramApi();
    const channel = createTelegramChannel('123:abc');
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(150)).join('\n\n');
    await channel.deliver('telegram:42', null, { kind: 'chat-sdk', content: { markdown: paragraphs } });
    const texts = sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text as string);
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4096);
    expect(texts.join('')).toContain('Paragraph 11');
  });

  it('converts Markdown to MarkdownV2', async () => {
    const sent = stubTelegramApi();
    const channel = createTelegramChannel('123:abc');
    await channel.deliver('telegram:42', null, { kind: 'chat-sdk', content: { markdown: '**bold** a.b' } });
    const body = sent.find((s) => s.method === 'sendMessage')!.body;
    expect(body.parse_mode).toBe('MarkdownV2');
    expect(body.text).toBe('*bold* a\\.b');
  });
});
