import { describe, expect, it, vi } from 'vitest';
import { createActivityLog } from '../../../src/core/platform/activity.js';

describe('activity log', () => {
  it('a run shows while running, with progress and notes, then moves to recent with its result', () => {
    let t = Date.parse('2026-09-30T10:00:00Z');
    const onChange = vi.fn();
    const log = createActivityLog({ now: () => t, onChange });
    const run = log.start('pr-watch', 'Checking pull requests');
    run.progress(1, 3);
    run.note('api feat/x: archived — every PR merged', { level: 'action', sessionId: 's1' });
    let snap = log.snapshot();
    expect(snap.running).toHaveLength(1);
    expect(snap.running[0]).toMatchObject({
      status: 'running',
      progress: { done: 1, total: 3 },
      notes: [{ level: 'action', sessionId: 's1' }],
    });
    t += 5000;
    run.done('3 sessions · 1 archived');
    run.note('ignored after the end');
    snap = log.snapshot();
    expect(snap.running).toEqual([]);
    expect(snap.recent[0]).toMatchObject({ status: 'done', summary: '3 sessions · 1 archived', endedAt: '2026-09-30T10:00:05.000Z' });
    expect(snap.recent[0].notes).toHaveLength(1);
    expect(onChange).toHaveBeenCalled();
  });

  it('keeps the newest runs, newest first; a failure keeps its reason', () => {
    const log = createActivityLog({ keep: 2 });
    for (const n of [1, 2, 3]) log.start('jira', `run ${n}`).done('ok');
    log.start('pr-list', 'Listing open pull requests').fail('gh: not logged in');
    expect(log.snapshot().recent.map((r) => r.label)).toEqual(['Listing open pull requests', 'run 3']);
    expect(log.snapshot().recent[0]).toMatchObject({ status: 'failed', summary: 'gh: not logged in' });
  });

  it('the same skip repeated is one row with a count', () => {
    const log = createActivityLog();
    log.skip('pr-watch', 'Checking pull requests', "GitHub's API limit is spent");
    log.skip('pr-watch', 'Checking pull requests', "GitHub's API limit is spent");
    log.skip('pr-watch', 'Checking pull requests', 'turned off');
    const recent = log.snapshot().recent;
    expect(recent.map((r) => [r.summary, r.repeats ?? 0])).toEqual([
      ['turned off', 0],
      ["GitHub's API limit is spent", 1],
    ]);
  });

  it('a schedule says when it runs next, and why it rests', () => {
    const t = Date.parse('2026-09-30T10:00:00Z');
    const log = createActivityLog({ now: () => t });
    const s = log.schedule('pr-watch', 'Pull request check', 180_000);
    s.next(t + 180_000);
    expect(log.snapshot().schedules[0]).toMatchObject({ everyMs: 180_000, nextAt: '2026-09-30T10:03:00.000Z', pausedUntil: null });
    s.pause(t + 600_000, "GitHub's API limit is spent");
    expect(log.snapshot().schedules[0]).toMatchObject({
      pausedUntil: '2026-09-30T10:10:00.000Z',
      pausedWhy: "GitHub's API limit is spent",
    });
    s.resume();
    expect(log.snapshot().schedules[0].pausedUntil).toBeNull();
  });

  it('snapshots are copies: later changes do not rewrite what was sent', () => {
    const log = createActivityLog();
    const run = log.start('idle-sleep', 'Looking for idle Claudes');
    const before = log.snapshot();
    run.progress(2, 2);
    expect(before.running[0].progress).toBeNull();
  });
});
