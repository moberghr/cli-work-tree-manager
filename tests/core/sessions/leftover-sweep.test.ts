import { describe, expect, it } from 'vitest';
import { leftoverSummary, sweepLeftovers } from '../../../src/core/sessions/leftover-sweep.js';
import type { ProcessUsage } from '../../../src/core/platform/process-usage.js';

/** The background look for what sessions left running. */
const NOW = Date.parse('2026-11-16T12:00:00Z');
const MB = 1024 * 1024;
const p = (pid: number, ppid: number, command: string, mb: number, agoH: number): ProcessUsage => ({
  pid,
  ppid,
  name: command.split(' ')[0],
  exe: null,
  command,
  memBytes: mb * MB,
  startedAt: NOW - agoH * 3_600_000,
});

describe('sweepLeftovers', () => {
  const sessions = () => [
    { id: 'a', name: 'api · feat/x', paths: ['/wt/a'] },
    { id: 'b', name: 'web · feat/y', paths: ['/wt/b'] },
    { id: 'c', name: 'docs · main', paths: ['/wt/c'] },
  ];
  const procs = [
    p(100, 1, 'claude', 700, 60),
    p(101, 100, 'node vite.js --mode mock', 1340, 50),
    p(102, 100, 'node vite.js --mode demo', 170, 48),
    p(103, 100, 'node watch.js', 30, 30),
    p(104, 100, 'dotnet test', 500, 0.1),
    p(200, 1, 'claude', 700, 2),
    p(201, 200, 'npm run build', 90, 1),
  ];
  const run = async (list: ProcessUsage[] = procs) => {
    const notes: Array<{ text: string; sessionId: string }> = [];
    const found = await sweepLeftovers({
      sessions,
      list: async () => list,
      agentPid: (id) => ({ a: 100, b: 200 })[id] ?? null,
      note: (text, o) => void notes.push({ text, sessionId: o.sessionId }),
      now: () => NOW,
    });
    return { found, notes };
  };

  it('says which session left what running for over a day, with how much it holds — and nothing of the rest', async () => {
    const { found, notes } = await run();
    expect(found).toEqual({ sessions: 1, processes: 3, bytes: 1540 * MB });
    expect(notes).toEqual([
      {
        sessionId: 'a',
        text: 'api · feat/x: 3 processes left running for over a day (1.5 GB): node vite.js --mode mock; node vite.js --mode demo and 1 more — its ⋯ menu → Processes… stops them',
      },
    ]);
  });

  it('nothing left running: no note; processes that can’t be read: said, never "nothing"', async () => {
    const fresh = await run(procs.filter((x) => x.pid >= 200 || x.pid === 100 || x.pid === 104));
    expect(fresh.found).toEqual({ sessions: 0, processes: 0, bytes: 0 });
    expect(fresh.notes).toEqual([]);
    expect((await run([])).found).toBeNull();
  });

  it('the outcome in a line', () => {
    expect(leftoverSummary(null)).toBe("couldn't read the running processes");
    expect(leftoverSummary({ sessions: 0, processes: 0, bytes: 0 })).toBe('nothing left running for over a day');
    expect(leftoverSummary({ sessions: 1, processes: 1, bytes: 300 * MB })).toBe(
      '1 process left running for over a day in 1 session (300 MB)',
    );
    expect(leftoverSummary({ sessions: 2, processes: 5, bytes: 3072 * MB })).toBe(
      '5 processes left running for over a day in 2 sessions (3.0 GB)',
    );
  });
});
