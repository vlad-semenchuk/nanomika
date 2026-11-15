import { describe, expect, it } from 'vitest';

import { normalizeOptions } from './ask-question.js';
import { formatQuestionText, parseAnswerCommand, resolveOption } from './cli.js';

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
