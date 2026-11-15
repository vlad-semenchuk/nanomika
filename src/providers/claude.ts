/**
 * Claude provider container config. Not imported by default (see
 * providers/index.ts).
 *
 * You normally don't need this: the host credential proxy
 * (src/credential-proxy.ts) already forwards container traffic to
 * ANTHROPIC_BASE_URL from .env and injects the real credentials.
 *
 * Importing this file makes the container call ANTHROPIC_BASE_URL directly,
 * bypassing the proxy, with a placeholder token:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — no real credential enters the container
 * Only use it for an endpoint that needs no key (e.g. a local model server).
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  return { env };
});
