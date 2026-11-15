import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from './env.js';

describe('readEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanomika-env-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(content: string): void {
    fs.writeFileSync(path.join(dir, '.env'), content);
  }

  it('returns only the requested keys and skips comments and empty values', () => {
    write('# comment\nA=1\nB=2\nC=\n# D=4\n');
    expect(readEnvFile(['A', 'C', 'D'])).toEqual({ A: '1' });
  });

  it('strips a trailing comment from an unquoted value', () => {
    write('NAME=Andy        # default Andy\nTOKEN=abc#def\nEMPTY=   # nothing here\n');
    expect(readEnvFile(['NAME', 'TOKEN', 'EMPTY'])).toEqual({ NAME: 'Andy', TOKEN: 'abc#def' });
  });

  it('keeps a quoted value verbatim, including # and spaces', () => {
    write('A="x # y"\nB=\'p q\'\n');
    expect(readEnvFile(['A', 'B'])).toEqual({ A: 'x # y', B: 'p q' });
  });

  it('returns an empty object when there is no .env', () => {
    expect(readEnvFile(['A'])).toEqual({});
  });
});
