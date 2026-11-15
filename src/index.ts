/**
 * NanoMika — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import type { Server } from 'http';

import { CONTAINER_IMAGE, CREDENTIAL_PROXY_PORT, DATA_DIR } from './config.js';
import { bootstrapFirstAgent } from './bootstrap.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { ensureCredentialsConfigured, startCredentialProxy } from './credential-proxy.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import {
  ensureContainerRuntimeRunning,
  ensureAgentImagePresent,
  cleanupOrphans,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Add or enable a channel by editing channels/index.ts.
import './channels/index.js';

// Modules barrel — imported for side effects (each module registers its
// hooks, delivery actions and response handlers).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { ensureSocketPathFits, startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

let credentialProxyServer: Server | undefined;

async function startProxyOrExplain(): Promise<Server> {
  if (!PROXY_BIND_HOST) {
    console.error('\nFATAL: cannot pick an address for the credential proxy (no docker0 interface).');
    console.error(
      'Set CREDENTIAL_PROXY_HOST to an address your containers can reach, e.g. CREDENTIAL_PROXY_HOST=172.17.0.1 pnpm start\n',
    );
    throw new Error('Credential proxy address unknown: set CREDENTIAL_PROXY_HOST');
  }
  try {
    return await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`\nFATAL: port ${CREDENTIAL_PROXY_PORT} is in use. Is another NanoMika host already running?`);
      console.error('Stop it, or start this one on another port, e.g. CREDENTIAL_PROXY_PORT=3002 pnpm start\n');
    }
    throw err;
  }
}

async function main(): Promise<void> {
  log.info('NanoMika starting');

  // 0. Preflight: fail fast on missing config before the restart backoff, so
  // fixing one thing at a time never waits on the circuit breaker.
  ensureSocketPathFits();
  ensureCredentialsConfigured();
  ensureContainerRuntimeRunning();
  ensureAgentImagePresent(CONTAINER_IMAGE);

  // Credential proxy — containers route Anthropic API calls through this
  // host-side proxy, which injects the real key/token. Started before the
  // orphan cleanup, so a second host in the same checkout fails here instead
  // of stopping the first host's containers.
  credentialProxyServer = await startProxyOrExplain();

  // 0b. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. First start: create the first agent and wire it to the local CLI
  // when the DB has no agent groups. No-op afterwards.
  bootstrapFirstAgent();

  // 2. Container runtime: reap this install's orphans from a previous run
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoMika running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  credentialProxyServer?.close();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
