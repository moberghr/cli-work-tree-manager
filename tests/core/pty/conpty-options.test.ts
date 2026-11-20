import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conptyOptions, lowerPriority, slowStart } from '../../../src/core/pty/pty-session.js';
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

describe('an agent below normal priority (config agentsLowPriority)', () => {
  it('asks the system for below-normal on its pid; what it starts inherits it', () => {
    const calls: Array<[number, number]> = [];
    expect(lowerPriority(4242, (pid, p) => void calls.push([pid, p]))).toBeNull();
    expect(calls).toEqual([[4242, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
  });

  it('a refusal (the process already gone, no right to) is said, never thrown: the agent runs on at normal priority', () => {
    expect(
      lowerPriority(1, () => {
        throw new Error('ESRCH: no such process');
      }),
    ).toBe('ESRCH: no such process');
  });

  it('really lowers a process of ours (this one), on this system', () => {
    const before = os.getPriority(process.pid);
    try {
      expect(lowerPriority(process.pid)).toBeNull();
      expect(os.getPriority(process.pid)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    } finally {
      // Back up needs no right on Windows; on POSIX a process can't raise itself again, and the test worker ends anyway.
      try {
        os.setPriority(process.pid, before);
      } catch {
        /* POSIX: stays lowered for this short-lived worker */
      }
    }
  });

  it('config takes a boolean, and only that', () => {
    const file = path.join(os.homedir(), '.work', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write = (extra: object) =>
      fs.writeFileSync(file, JSON.stringify({ worktreesRoot: os.homedir(), repos: {}, groups: {}, copyFiles: [], ...extra }));
    write({ agentsLowPriority: true });
    expect(loadConfig()?.agentsLowPriority).toBe(true);
    write({ agentsLowPriority: 1 });
    expect(loadConfig()?.agentsLowPriority).toBeUndefined();
  });
});
