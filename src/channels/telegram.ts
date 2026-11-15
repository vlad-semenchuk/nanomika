/**
 * Telegram channel adapter: Chat SDK bridge in long-polling mode.
 * Self-registers on import. Polling is outbound only, so no port is opened.
 *
 * The adapter converts Markdown to MarkdownV2 and renders ask_question cards
 * as inline keyboards. The bridge already encodes button ids as option indexes
 * to stay under Telegram's 64-byte callback_data cap.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// Telegram caps a message at 4096 characters and the adapter cuts anything
// longer. MarkdownV2 escaping makes the sent text longer than the source, so
// split below the cap.
const TELEGRAM_CHUNK_LIMIT = 3500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  const reply = raw.reply_to_message;
  if (!reply) return null;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/**
 * In groups, Telegram clients send `/clear@botname`. The command gate matches
 * the bare command, so drop the bot suffix, otherwise an admin command would
 * pass the gate as an unknown one.
 */
export function stripBotSuffix(text: string, botUsername: string): string {
  const match = /^(\/\w+)@(\w+)(?=\s|$)/.exec(text);
  return match && match[2].toLowerCase() === botUsername.toLowerCase() ? match[1] + text.slice(match[0].length) : text;
}

export function createTelegramChannel(token: string): ChannelAdapter {
  const telegramAdapter = createTelegramAdapter({ botToken: token, mode: 'polling' });
  const bridge = createChatSdkBridge({
    adapter: telegramAdapter,
    concurrency: 'concurrent',
    extractReplyContext,
    supportsThreads: false,
    // Polling receives updates over outbound requests; open no port for it.
    webhook: false,
    maxTextLength: TELEGRAM_CHUNK_LIMIT,
  });
  return {
    ...bridge,
    setup: (hostConfig: ChannelSetup) =>
      bridge.setup({
        ...hostConfig,
        onInbound: (platformId, threadId, message) => {
          const content = message.content as { text?: unknown } | null;
          if (content && typeof content.text === 'string') {
            content.text = stripBotSuffix(content.text, telegramAdapter.userName);
          }
          return hostConfig.onInbound(platformId, threadId, message);
        },
      }),
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const { TELEGRAM_BOT_TOKEN } = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    return TELEGRAM_BOT_TOKEN ? createTelegramChannel(TELEGRAM_BOT_TOKEN) : null;
  },
});
