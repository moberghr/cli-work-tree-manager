import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isPidAlive,
  isZombie,
  linuxProcessName,
  linuxProcessTable,
  processName,
  type ProcReader,
} from '../../../src/core/platform/process.js';

/** A /proc with the given entries. */
const proc = (entries: Record<number, { exe?: string; cmdline?: string; comm?: string }>): ProcReader => ({
  link: (p) => entries[Number(p.split('/')[2])]?.exe ?? null,
  file: (p) => {
    const e = entries[Number(p.split('/')[2])];
    return p.endsWith('/cmdline') ? (e?.cmdline ?? null) : p.endsWith('/comm') ? (e?.comm ?? null) : null;
  },
  pids: () => Object.keys(entries).map(Number),
});

describe('process names on Linux, from /proc', () => {
  it("a node process is node, not its main thread's name (Node 24 calls it MainThread)", () => {
    const read = proc({ 7: { exe: '/usr/bin/node', cmdline: 'node\0/usr/lib/claude/cli.js\0', comm: 'MainThread' } });
    expect(linuxProcessName(7, read)).toBe('node');
  });

  it("someone else's process (no exe to read): its command line's first word, else its comm", () => {
    expect(linuxProcessName(8, proc({ 8: { cmdline: '/usr/local/bin/claude\0--continue\0', comm: 'MainThread' } }))).toBe('claude');
    expect(linuxProcessName(9, proc({ 9: { comm: 'kworker/0:1\n' } }))).toBe('kworker/0:1');
    expect(linuxProcessName(10, proc({}))).toBeNull();
  });

  it('a replaced executable still reads as its name', () => {
    expect(linuxProcessName(11, proc({ 11: { exe: '/usr/bin/node (deleted)' } }))).toBe('node');
  });

  it('the table: every readable process by pid', () => {
    const table = linuxProcessTable(proc({ 1: { comm: 'systemd' }, 42: { exe: '/opt/node/bin/node' }, 43: {} }));
    expect([...table]).toEqual([
      [1, 'systemd'],
      [42, 'node'],
    ]);
  });

  it.runIf(process.platform === 'linux')('this test runner reads as node', () => {
    expect(processName(process.pid)).toMatch(/^node$/);
  });
});

describe('isZombie (exited, not yet collected: kill(0) still answers)', () => {
  const stat = (text: string | null) => ({ file: (p: string) => (p === '/proc/42/stat' ? text : null) });
  it('reads the state after the command name — which can hold spaces and parentheses', () => {
    expect(isZombie(42, stat('42 (node) Z 1 42 42 0 -1'), 'linux')).toBe(true);
    expect(isZombie(42, stat('42 (work web (dev)) Z 1 42'), 'linux')).toBe(true);
    expect(isZombie(42, stat('42 (node) S 1 42 42 0 -1'), 'linux')).toBe(false);
    expect(isZombie(42, stat(null), 'linux')).toBe(false); // gone, or no /proc
    expect(isZombie(42, stat('42 (node) Z 1'), 'win32')).toBe(false); // Linux only
    expect(isZombie(42, stat('4Z'), 'linux')).toBe(false); // no command name: not read as a state
  });

  it('this process is alive, and not a zombie', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('spawnDetachedWork (the PTY host, a background work web)', () => {
  it("starts in the home folder, not the caller's: a server working from a folder keeps it in use on Windows", async () => {
    vi.resetModules();
    const spawned: Array<{ cwd?: string }> = [];
    vi.doMock('node:child_process', async (orig) => ({
      ...(await orig<typeof import('node:child_process')>()),
      spawn: (_cmd: string, _args: string[], opts: { cwd?: string }) => {
        spawned.push(opts);
        return { unref: () => {} };
      },
    }));
    const { spawnDetachedWork } = await import('../../../src/core/platform/process.js');
    const log = path.join(os.tmpdir(), `detached-${process.pid}.log`);
    spawnDetachedWork('/x/bin.js', ['pty-host'], log);
    expect(spawned[0].cwd).toBe(os.homedir());
    vi.doUnmock('node:child_process');
    fs.rmSync(log, { force: true });
  });
});
