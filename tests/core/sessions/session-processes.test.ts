import { describe, expect, it } from 'vitest';
import { descendantsOf, sessionProcesses, stopRefusal } from '../../../src/core/sessions/session-processes.js';
import { formatAge, formatBytes, LEFTOVER_AFTER_MS, processesLine } from '../../../src/core/sessions/process-view.js';
import { elapsedMs, parseCimUsage, parsePsUsage, type ProcessUsage } from '../../../src/core/platform/process-usage.js';

/** What a session's agent and the things it started hold in memory. */
const NOW = Date.parse('2026-11-16T12:00:00Z');
const MB = 1024 * 1024;
const HOUR = 3_600_000;
const proc = (pid: number, ppid: number, command: string, mb: number, agoH: number, over: Partial<ProcessUsage> = {}): ProcessUsage => ({
  pid,
  ppid,
  name: command.split(' ')[0].split('/').pop()!,
  exe: command.split(' ')[0].startsWith('/') ? command.split(' ')[0] : null,
  command,
  memBytes: mb * MB,
  startedAt: NOW - agoH * HOUR,
  ...over,
});

const WT = '/wt/feat-x';
const PROCS: ProcessUsage[] = [
  proc(1, 0, '/sbin/init', 10, 300),
  proc(100, 1, '/usr/bin/claude --continue', 760, 60),
  proc(110, 100, '/bin/bash -c npm run dev', 5, 50),
  proc(111, 110, `/usr/bin/node ${WT}/node_modules/vite/bin/vite.js --mode mock`, 1340, 50),
  proc(120, 100, '/usr/bin/dotnet test', 510, 0.2),
  // Started from a terminal of yours, not by the agent — but it runs from the session's folder.
  proc(300, 1, `/usr/bin/node ${WT}/scripts/watch.js`, 90, 30),
  // Someone else's.
  proc(400, 1, '/usr/bin/node /other/server.js', 900, 5),
  proc(401, 400, '/usr/bin/node /other/worker.js', 100, 5),
];

describe('descendantsOf', () => {
  it('a root and everything under it, however deep; a root that isn’t running gives nothing', () => {
    expect([...descendantsOf(PROCS, new Set([100]))].sort((a, b) => a - b)).toEqual([100, 110, 111, 120]);
    expect([...descendantsOf(PROCS, new Set([999]))]).toEqual([]);
    expect([...descendantsOf(PROCS, new Set())]).toEqual([]);
  });
});

describe('sessionProcesses', () => {
  const of = (procs = PROCS, agent = [100]) => sessionProcesses(procs, { agentPids: new Set(agent), dirs: [WT], now: NOW, windows: false });

  it('its agent, what the agent started and what runs from its folder — most memory first, with the total; nothing else', () => {
    const w = of();
    expect(w.processes.map((p) => p.pid)).toEqual([111, 100, 120, 300, 110]);
    expect(w.totalBytes).toBe((1340 + 760 + 510 + 90 + 5) * MB);
    expect(w.at).toBe(NOW);
    expect(w.processes.find((p) => p.pid === 100)).toMatchObject({ agent: true, what: 'claude --continue' });
    // The folder is shortened in what it says, and the pid has its own field.
    expect(w.processes.find((p) => p.pid === 111)?.what).toBe('node …/node_modules/vite/bin/vite.js --mode mock');
  });

  it('something other than the agent, running for over a day, is a leftover (reported: dev servers left for two days held 3 GB)', () => {
    const w = of();
    expect(w.processes.filter((p) => p.leftover).map((p) => p.pid)).toEqual([111, 300, 110]);
    expect(w.leftovers).toBe(3);
    // The agent never is, however long it has run; nor a test run from ten minutes ago.
    const old = of(PROCS.map((p) => (p.pid === 100 ? { ...p, startedAt: NOW - 90 * HOUR } : p)));
    expect(old.processes.find((p) => p.pid === 100)).not.toHaveProperty('leftover');
    expect(w.processes.find((p) => p.pid === 120)).not.toHaveProperty('leftover');
    // Exactly a day counts; a start time the system didn't give never does.
    const edge = of([
      proc(100, 1, 'claude', 1, 30),
      proc(5, 100, 'x', 1, LEFTOVER_AFTER_MS / HOUR),
      proc(6, 100, 'y', 1, 0, { startedAt: null }),
    ]);
    expect(edge.processes.filter((p) => p.leftover).map((p) => p.pid)).toEqual([5]);
  });

  it('a "child" older than its parent was started by an earlier process of that number: not the agent’s', () => {
    // pid 100 was reused by the agent 3 h ago; 500 names 100 as its parent but has run for 80 h.
    const w = of([...PROCS, proc(500, 100, '/usr/bin/node /elsewhere/old.js', 2000, 80)]);
    expect(w.processes.map((p) => p.pid)).not.toContain(500);
  });

  it('no agent running (asleep): only what runs from its folder; nothing of it: empty', () => {
    expect(of(PROCS, []).processes.map((p) => p.pid)).toEqual([111, 300]);
    const none = sessionProcesses(PROCS, { agentPids: new Set(), dirs: ['/wt/other'], now: NOW, windows: false });
    expect(none).toEqual({ at: NOW, totalBytes: 0, leftovers: 0, processes: [] });
  });

  it('memory the system didn’t give counts as none, and sorts last', () => {
    const w = of([proc(100, 1, 'claude', 10, 1), proc(7, 100, 'x', 0, 1, { memBytes: null })]);
    expect(w.processes.map((p) => [p.pid, p.memBytes])).toEqual([
      [100, 10 * MB],
      [7, null],
    ]);
    expect(w.totalBytes).toBe(10 * MB);
  });
});

describe('stopRefusal', () => {
  const w = sessionProcesses(PROCS, { agentPids: new Set([100]), dirs: [WT], now: NOW, windows: false });
  const started = (pid: number) => w.processes.find((p) => p.pid === pid)!.startedAt;

  it('one of its processes, as it was listed: may be stopped', () => {
    expect(stopRefusal(w, 111, started(111))).toBeNull();
  });

  it('never the agent, never a pid that isn’t the session’s, never one that started at another time (a reused pid)', () => {
    expect(stopRefusal(w, 100, started(100))).toMatch(/its agent/);
    expect(stopRefusal(w, 400, NOW - 5 * HOUR)).toMatch(/no longer running for this session/);
    expect(stopRefusal(w, 111, started(111)! + 60_000)).toMatch(/not the one that was listed/);
    expect(stopRefusal(w, 111, null)).toMatch(/not the one that was listed/);
  });
});

describe('process-view', () => {
  it('sizes, ages and the summary line', () => {
    expect([0, 312 * MB, 1023.4 * MB, 1434 * MB].map(formatBytes)).toEqual(['0 MB', '312 MB', '1023 MB', '1.4 GB']);
    expect([30_000, 12 * 60_000, 5 * HOUR, 47 * HOUR, 50 * HOUR, -5].map(formatAge)).toEqual(['0m', '12m', '5h', '47h', '2d', '0m']);
    expect(processesLine({ totalBytes: 1434 * MB, leftovers: 2, processes: [1, 2, 3, 4, 5, 6] })).toBe(
      '1.4 GB in 6 processes · 2 left running for over a day',
    );
    expect(processesLine({ totalBytes: 760 * MB, leftovers: 0, processes: [1] })).toBe('760 MB in 1 process');
    expect(processesLine({ totalBytes: 0, leftovers: 0, processes: [] })).toBe('Nothing of it is running.');
  });
});

describe('reading the processes', () => {
  it('Windows: Get-CimInstance as JSON — private bytes and the start in ms; a list or one object; junk is nothing', () => {
    const json = JSON.stringify([
      { ProcessId: 4, ParentProcessId: 0, Name: 'System', ExecutablePath: null, CommandLine: null, PrivatePageCount: 40960, Started: 0 },
      {
        ProcessId: 9644,
        ParentProcessId: 6344,
        Name: 'node.exe',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
        CommandLine: 'node vite.js --mode mock',
        PrivatePageCount: 1434451968,
        Started: 1794571535000,
      },
      { Name: 'no pid' },
    ]);
    expect(parseCimUsage(json)).toEqual([
      { pid: 4, ppid: 0, name: 'System', exe: null, command: '', memBytes: 40960, startedAt: null },
      {
        pid: 9644,
        ppid: 6344,
        name: 'node.exe',
        exe: 'C:\\Program Files\\nodejs\\node.exe',
        command: 'node vite.js --mode mock',
        memBytes: 1434451968,
        startedAt: 1794571535000,
      },
    ]);
    expect(parseCimUsage(JSON.stringify({ ProcessId: 1, Name: 'a' }))).toHaveLength(1);
    expect(parseCimUsage('not json')).toEqual([]);
  });

  it('macOS and Linux: ps with rss (KB) and elapsed time', () => {
    const out = [
      '    1     0   1024    12-03:04:05 /sbin/init',
      '  812   100 524288       02:03 /usr/bin/node /wt/x/server.js --port 3000',
      'garbage',
    ].join('\n');
    expect(parsePsUsage(out, NOW)).toEqual([
      {
        pid: 1,
        ppid: 0,
        name: 'init',
        exe: '/sbin/init',
        command: '/sbin/init',
        memBytes: 1024 * 1024,
        startedAt: NOW - elapsedMs('12-03:04:05')!,
      },
      {
        pid: 812,
        ppid: 100,
        name: 'node',
        exe: '/usr/bin/node',
        command: '/usr/bin/node /wt/x/server.js --port 3000',
        memBytes: 524288 * 1024,
        startedAt: NOW - 123_000,
      },
    ]);
    expect([elapsedMs('02:03'), elapsedMs('1:02:03'), elapsedMs('2-01:02:03'), elapsedMs('soon')]).toEqual([
      123_000,
      3_723_000,
      (2 * 24 * 3600 + 3723) * 1000,
      null,
    ]);
  });
});
