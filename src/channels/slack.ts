/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN']);
    if (!env.SLACK_BOT_TOKEN) return null;
    // Socket Mode (outbound WebSocket, no public ingress) is preferred on
    // locked-down hosts where an inbound webhook to /webhook/slack is blocked.
    // It engages automatically when an app-level token (xapp-…) is present;
    // otherwise we fall back to webhook mode (needs SLACK_SIGNING_SECRET and a
    // publicly reachable /webhook/slack endpoint).
    const slackAdapter = env.SLACK_APP_TOKEN
      ? createSlackAdapter({
          botToken: env.SLACK_BOT_TOKEN,
          appToken: env.SLACK_APP_TOKEN,
          mode: 'socket',
        })
      : createSlackAdapter({
          botToken: env.SLACK_BOT_TOKEN,
          signingSecret: env.SLACK_SIGNING_SECRET,
        });
    const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
});
