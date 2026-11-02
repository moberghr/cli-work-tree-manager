import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conptyOptions, slowStart } from '../../../src/core/pty/pty-session.js';
import { loadConfig } from '../../../src/core/platform/config.js';

describe('which ConPTY a terminal starts on (config useBundledConpty)', () => {
  it("Windows: the bundled one when asked for, Windows' own otherwise; elsewhere nothing to choose", () => {
    expect(conptyOptions('win32', true)).toEqual({ useConptyDll: true });
    expect(conptyOptions('win32', false)).toEqual({});
    expect(conptyOptions('darwin', true)).toEqual({});
    expect(conptyOptions('linux', true)).toEqual({});
  });

  it('config takes a boolean, and only that', () => {
    // Each test file has its own HOME (tests/setup): this config.json is a throwaway.
    const file = path.join(os.homedir(), '.work', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write = (extra: object) =>
      fs.writeFileSync(file, JSON.stringify({ worktreesRoot: os.homedir(), repos: {}, groups: {}, copyFiles: [], ...extra }));
    write({ useBundledConpty: true });
    expect(loadConfig()?.useBundledConpty).toBe(true);
    write({ useBundledConpty: 'yes' });
    expect(loadConfig()?.useBundledConpty).toBeUndefined();
  });
});

describe('a slow terminal start (node-pty holds the whole host while it starts one)', () => {
  it('quiet under 1 s, a note in the debug line from 1 s, a warning from 5 s', () => {
    expect(slowStart(150)).toEqual({ note: '', warn: null });
    expect(slowStart(2400)).toEqual({ note: '(the start took 2400 ms)', warn: null });
    expect(slowStart(61_000).warn).toBe('[pty] starting a terminal took 61 s: the PTY host answered nothing meanwhile');
  });
});
