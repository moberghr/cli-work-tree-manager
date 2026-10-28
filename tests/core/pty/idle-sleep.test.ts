import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SLEEP_AFTER_MINUTES,
  sleepAfterMs,
  sleepCandidates,
  sleepPlan,
  stillAtWork,
  type SleepChecks,
} from '../../../src/core/pty/idle-sleep.js';
import type { PtyInfo } from '../../../src/core/pty/pty-host-protocol.js';

const NOW = Date.parse('2026-09-30T18:00:00Z');
const HOUR = 3_600_000;
const pty = (id: string, over: Partial<PtyInfo> = {}): PtyInfo => ({
  id,
  cwd: `/wt/${id}`,
  pid: 1,
  exited: false,
  cols: 80,
  rows: 24,
  startedAt: '',
  restored: false,
  clients: 0,
  lastOutputAt: new Date(NOW - 5 * HOUR).toISOString(),
  ...over,
});
const idle = () => false;

describe('sleepCandidates', () => {
  it('puts to sleep a Claude quiet for long enough with nothing attached', () => {
    expect(sleepCandidates([pty('a')], NOW, 4 * HOUR, idle)).toEqual(['a']);
  });

  it('keeps one that is attached, recently printed or busy; the Ctrl+K assistant sleeps by the same rules (it was kept for good)', () => {
    const ptys = [
      pty('watched', { clients: 1 }),
      pty('recent', { lastOutputAt: new Date(NOW - HOUR).toISOString() }),
      pty('busy'),
      pty('gone', { exited: true }),
    ];
    expect(sleepCandidates(ptys, NOW, 4 * HOUR, (id) => id === 'busy')).toEqual([]);
    expect(sleepCandidates([pty('assistant')], NOW, 4 * HOUR, () => false)).toEqual(['assistant']);
    expect(sleepCandidates([pty('assistant', { clients: 1 })], NOW, 4 * HOUR, () => false)).toEqual([]); // its panel open
  });

  it('never acts on a host that does not report clients, or when switched off', () => {
    expect(sleepCandidates([pty('old-host', { clients: undefined })], NOW, 4 * HOUR, idle)).toEqual([]);
    expect(sleepCandidates([pty('a')], NOW, 0, idle)).toEqual([]);
  });
});

describe('sleepAfterMs', () => {
  it('0 = never; ten minutes by default; nothing shorter than five (a sleep is recorded, so the Terminal tab wakes it)', () => {
    expect(DEFAULT_SLEEP_AFTER_MINUTES).toBe(10);
    expect(sleepAfterMs(0)).toBe(0);
    expect(sleepAfterMs(2)).toBe(5 * 60_000);
    expect(sleepAfterMs(10)).toBe(10 * 60_000);
    expect(sleepAfterMs(240)).toBe(240 * 60_000);
  });
});

describe('stillAtWork — idle means idle: a quiet Claude still doing something is never stopped', () => {
  const p = { id: 's1', pid: 42, startedAt: '2026-09-30T17:00:00Z' };
  const idle = (over: Partial<SleepChecks> = {}): SleepChecks => ({
    shown: () => 'idle',
    live: () => 'idle',
    backgroundCommands: () => 0,
    runningFrom: async () => [],
    ...over,
  });

  it('truly idle: may sleep', async () => {
    expect(await stillAtWork(p, idle())).toBeNull();
  });

  it('working, waiting for you, Claude Code busy (a background agent) or at a dialog: awake', async () => {
    expect(await stillAtWork(p, idle({ shown: () => 'working' }))).toMatch(/working/);
    expect(await stillAtWork(p, idle({ shown: () => 'needs_input' }))).toMatch(/answer/);
    expect(await stillAtWork(p, idle({ live: () => 'busy' }))).toMatch(/busy/);
    expect(await stillAtWork(p, idle({ live: () => 'waiting' }))).toMatch(/dialog/);
  });

  it('a background command it started still running: awake — asked from the Claude process start, its pid passed along', async () => {
    const live = vi.fn(() => 'idle' as const);
    const backgroundCommands = vi.fn(() => 2);
    expect(await stillAtWork(p, idle({ live, backgroundCommands }))).toBe('2 background commands it started are still running');
    expect(live).toHaveBeenCalledWith('s1', 42);
    expect(backgroundCommands).toHaveBeenCalledWith('s1', Date.parse(p.startedAt));
  });

  it('something still running from its folder (a dev server, a watcher): awake, named', async () => {
    const why = await stillAtWork(p, idle({ runningFrom: async () => ['node vite.js (PID 1)', 'dotnet watch (PID 2)', 'x (PID 3)'] }));
    expect(why).toBe('still running from its folder: node vite.js (PID 1), dotnet watch (PID 2) and 1 more');
  });

  it("a check that can't tell keeps it awake (fail safe), whichever it is", async () => {
    const boom = () => {
      throw new Error('its session is gone');
    };
    expect(await stillAtWork(p, idle({ shown: boom }))).toMatch(/couldn't tell.*its session is gone/);
    expect(await stillAtWork(p, idle({ backgroundCommands: boom }))).toMatch(/couldn't tell/);
    expect(
      await stillAtWork(p, idle({ runningFrom: async () => Promise.reject(new Error("couldn't read the running processes")) })),
    ).toMatch(/couldn't tell/);
  });

  it('sleepPlan: the ones to stop, and why each other one stays', async () => {
    const plan = await sleepPlan([p, { ...p, id: 's2' }], idle({ shown: (id) => (id === 's2' ? 'working' : 'idle') }));
    expect(plan).toEqual({ sleep: ['s1'], awake: [{ id: 's2', why: 'its Claude is working' }] });
  });
});
