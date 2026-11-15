import fs from 'fs';
import net from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanomika-test-cli' };
});

import type { ChannelSetup } from './adapter.js';
import { normalizeOptions } from './ask-question.js';
import { getChannelAdapter, initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';
import { formatOutbound, formatQuestionText, parseAnswerCommand, resolveOption } from './cli.js';

const options = normalizeOptions([
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
]);

describe('CLI question cards', () => {
  it('renders numbered options and the answer command', () => {
    const text = formatQuestionText({
      questionId: 'appr-1',
      title: 'Install package',
      question: 'Allow curl?',
      options,
    });
    expect(text).toContain('Install package');
    expect(text).toContain('Allow curl?');
    expect(text).toContain('1. Approve');
    expect(text).toContain('2. Reject');
    expect(text).toContain('pnpm run chat /answer appr-1 <1-2>');
  });

  it('parses /answer and ignores other text', () => {
    expect(parseAnswerCommand('/answer appr-1 2')).toEqual({ questionId: 'appr-1', choice: '2' });
    expect(parseAnswerCommand('  /answer q-9   Not now ')).toEqual({ questionId: 'q-9', choice: 'Not now' });
    expect(parseAnswerCommand('/answer appr-1')).toBeNull();
    expect(parseAnswerCommand('hello')).toBeNull();
  });

  it('maps a number, label or value to the option value', () => {
    expect(resolveOption(options, '1')).toBe('approve');
    expect(resolveOption(options, '2')).toBe('reject');
    expect(resolveOption(options, 'approve')).toBe('approve');
    expect(resolveOption(options, 'REJECT')).toBe('reject');
    expect(resolveOption(options, '3')).toBeNull();
    expect(resolveOption(options, 'maybe')).toBeNull();
  });
});

describe('CLI outbound text', () => {
  const save = (name: string) => `data/cli-files/1-${name}`;
  const msg = (content: unknown, files?: { filename: string; data: Buffer }[]) => ({ kind: 'chat', content, files });

  it('shows text, markdown, edits and reactions', () => {
    expect(formatOutbound(msg({ text: 'hi' }), save)).toBe('hi');
    expect(formatOutbound(msg({ markdown: '**hi**' }), save)).toBe('**hi**');
    expect(formatOutbound(msg({ operation: 'edit', messageId: 'm', text: 'fixed' }), save)).toBe('(edited) fixed');
    expect(formatOutbound(msg({ operation: 'reaction', messageId: 'm', emoji: '👍' }), save)).toBe('(reaction 👍)');
  });

  it('shows a card by its fallback text, else its title and description', () => {
    expect(formatOutbound(msg({ type: 'card', card: { title: 'T' }, fallbackText: 'plain' }), save)).toBe('plain');
    expect(formatOutbound(msg({ type: 'card', card: { title: 'T', description: 'D' }, fallbackText: '' }), save)).toBe(
      'T\nD',
    );
  });

  it('saves attachments and prints their paths', () => {
    const out = formatOutbound(msg({ text: 'report' }, [{ filename: 'a.pdf', data: Buffer.from('x') }]), save);
    expect(out).toBe('report\n[file saved: data/cli-files/1-a.pdf]');
    expect(formatOutbound(msg({}), save)).toBeNull();
  });
});

describe('CLI backlog', () => {
  const DIR = '/tmp/nanomika-test-cli';
  const setup: ChannelSetup = { onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() };

  beforeAll(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    await initChannelAdapters(() => setup);
  });

  afterAll(async () => {
    await teardownChannelAdapters();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  /** Connect, send one line, collect the JSON lines received within `ms`. */
  function exchange(line: object, ms = 150): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(`${DIR}/cli.sock`);
      let buffer = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => (buffer += chunk.toString('utf8')));
      socket.on('connect', () => {
        socket.write(JSON.stringify(line) + '\n');
        setTimeout(() => {
          socket.end();
          resolve(
            buffer
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l)),
          );
        }, ms);
      });
    });
  }

  it('keeps messages delivered with no client and hands them to the next one, once', async () => {
    const adapter = getChannelAdapter('cli')!;
    await adapter.deliver('local', null, { kind: 'chat', content: { text: 'late reply' } });
    await adapter.deliver('local', null, {
      kind: 'chat',
      content: { type: 'ask_question', questionId: 'q-1', title: 'Approve?', question: '', options: ['Yes', 'No'] },
    });

    const first = await exchange({ backlog: true });
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual({ text: 'late reply', backlog: true });
    expect(first[1].text).toContain('/answer q-1');
    expect(setup.onInbound).not.toHaveBeenCalled();

    // Let the server see the first client close before the next one connects.
    await new Promise((r) => setTimeout(r, 50));
    expect(await exchange({ backlog: true })).toEqual([]);
  });

  it('answers a backlogged question by number', async () => {
    const lines = await exchange({ text: '/answer q-1 2' });
    expect(setup.onAction).toHaveBeenCalledWith('q-1', 'No', 'cli:local');
    expect(lines.map((l) => l.text)).toEqual(['[answered q-1: No]']);
  });
});
