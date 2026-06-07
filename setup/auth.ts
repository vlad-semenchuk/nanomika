/**
 * Step: auth — Verify or register an Anthropic credential in .env.
 *
 * Modes:
 *   --check                   (default) Verify an Anthropic credential exists in .env.
 *   --create --value <token>  Write an Anthropic credential to .env. Errors if one
 *                             already exists unless --force is passed.
 *
 * The credential proxy (src/credential-proxy.ts) reads ANTHROPIC_API_KEY /
 * CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN from .env and injects them into
 * outbound requests. The token value is never logged.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const CRED_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

interface Args {
  mode: 'check' | 'create';
  value?: string;
  force: boolean;
}

function parseArgs(args: string[]): Args {
  let mode: 'check' | 'create' = 'check';
  let value: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--check':
        mode = 'check';
        break;
      case '--create':
        mode = 'create';
        break;
      case '--value':
        value = val;
        i++;
        break;
      case '--force':
        force = true;
        break;
    }
  }

  if (mode === 'create' && !value) {
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'missing_value_for_create',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { mode, value, force };
}

function envPath(): string {
  return path.join(process.cwd(), '.env');
}

function readEnv(): string {
  const p = envPath();
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

/** Returns the credential key already present in .env, or null. */
function findCredentialKey(content: string): string | null {
  for (const key of CRED_KEYS) {
    if (new RegExp(`^${key}=.+$`, 'm').test(content)) return key;
  }
  return null;
}

/** Pick the .env key for a pasted token by shape. */
function keyForValue(value: string): string {
  return value.startsWith('sk-ant-oat') ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

function writeCredential(key: string, value: string): void {
  // `value` is a credential — never log it.
  const content = readEnv();
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + (content ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(envPath(), next);
}

export async function run(args: string[]): Promise<void> {
  const { mode, value, force } = parseArgs(args);
  const content = readEnv();
  const existingKey = findCredentialKey(content);

  if (mode === 'check') {
    emitStatus('AUTH', {
      SECRET_PRESENT: !!existingKey,
      ANTHROPIC_OK: !!existingKey,
      STATUS: existingKey ? 'success' : 'missing',
      ...(existingKey ? { SECRET_NAME: existingKey } : {}),
      LOG: 'logs/setup.log',
    });
    return;
  }

  // mode === 'create'
  if (existingKey && !force) {
    emitStatus('AUTH', {
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'anthropic_credential_already_exists',
      SECRET_NAME: existingKey,
      HINT: 'Re-run with --force to replace, or remove the existing .env line first.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  const key = existingKey ?? keyForValue(value!);
  try {
    writeCredential(key, value!);
  } catch (err) {
    log.error('writing credential to .env failed', { err });
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'env_write_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const updatedKey = findCredentialKey(readEnv());
  emitStatus('AUTH', {
    SECRET_PRESENT: !!updatedKey,
    ANTHROPIC_OK: !!updatedKey,
    CREATED: true,
    STATUS: updatedKey ? 'success' : 'failed',
    ...(updatedKey ? { SECRET_NAME: updatedKey } : {}),
    LOG: 'logs/setup.log',
  });
}
