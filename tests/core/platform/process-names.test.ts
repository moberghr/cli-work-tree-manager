import { describe, expect, it } from 'vitest';
import { linuxProcessName, linuxProcessTable, processName, type ProcReader } from '../../../src/core/platform/process.js';

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
