import { describe, expect, it, vi } from 'vitest';

import { ensureSocketPathFits } from '../../cli/socket-server.js';

describe('ensureSocketPathFits', () => {
  it('accepts a short path', () => {
    expect(() => ensureSocketPathFits('/tmp/nanomika/data/ncl.sock')).not.toThrow();
  });

  it('stops with a message naming the path when it exceeds the Unix socket limit', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const long = `/${'x'.repeat(120)}/data/ncl.sock`;
    expect(() => ensureSocketPathFits(long)).toThrow(/Socket path too long/);
    expect(err.mock.calls.flat().join('\n')).toContain('shorter path');
    err.mockRestore();
  });
});
