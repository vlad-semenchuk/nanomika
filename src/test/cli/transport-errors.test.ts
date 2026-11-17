import { describe, it, expect } from 'vitest';

import { formatTransportError } from '../../cli/transport-errors.js';

describe('formatTransportError', () => {
  it('suggests starting the host on ENOENT', () => {
    const out = formatTransportError(new Error('connect ENOENT /tmp/nanomika.sock'));
    expect(out).toContain('pnpm start');
    expect(out).toContain('pnpm dev');
  });

  it('renders the same on ECONNREFUSED', () => {
    const out = formatTransportError(new Error('connect ECONNREFUSED'));
    expect(out).toContain('pnpm start');
  });

  it('falls back to a generic transport error for other failures', () => {
    const out = formatTransportError(new Error('some unrelated failure'));
    expect(out).toBe('ncl: transport error: some unrelated failure\n');
  });
});
