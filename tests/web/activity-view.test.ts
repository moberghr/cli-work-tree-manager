import { describe, expect, it } from 'vitest';
import type { ActivityRun, ActivityWire } from '../../src/core/api-types.js';
import { activityAttention, activityQuietLine, collapseRuns } from '../../src/web/src/state/activity-view.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
let id = 0;
const run = (over: Partial<ActivityRun>): ActivityRun => ({
  id: ++id,
  kind: 'pr-watch',
  label: 'Checking pull requests',
  startedAt: '2026-10-03T11:00:00Z',
  endedAt: '2026-10-03T11:00:05Z',
  status: 'done',
  progress: null,
  summary: null,
  notes: [],
  ...over,
});
const wire = (over: Partial<ActivityWire>): ActivityWire => ({ running: [], recent: [], schedules: [], ...over });

describe('activityAttention: the dot colours only when a job needs you', () => {
  it('a job resting (GitHub limit) needs you', () => {
    const w = wire({
      schedules: [
        {
          kind: 'pr-watch',
          label: 'Pull request check',
          everyMs: 1,
          nextAt: null,
          pausedUntil: '2026-10-03T12:10:00Z',
          pausedWhy: 'rate limit',
        },
      ],
    });
    expect(activityAttention(w, NOW)).toBe('Pull request check is resting: rate limit');
    // A pause that's over doesn't.
    expect(activityAttention(w, Date.parse('2026-10-03T13:00:00Z'))).toBeNull();
  });

  it('a job that worked and now fails needs you; one that never worked here is not set up', () => {
    const jira = (status: ActivityRun['status']) =>
      run({ kind: 'jira', label: 'Fetching your Jira issues', status, summary: 'acli missing' });
    expect(activityAttention(wire({ recent: [jira('failed'), jira('failed')] }), NOW)).toBeNull();
    expect(activityAttention(wire({ recent: [jira('failed'), jira('done')] }), NOW)).toBe('Fetching your Jira issues failed: acli missing');
    // Working again: fine.
    expect(activityAttention(wire({ recent: [jira('done'), jira('failed'), jira('done')] }), NOW)).toBeNull();
  });

  it('busy is not attention; the tooltip says what runs', () => {
    const w = wire({ running: [run({ status: 'running', progress: { done: 2, total: 9 } }), run({ status: 'running', kind: 'jira' })] });
    expect(activityAttention(w, NOW)).toBeNull();
    expect(activityQuietLine(w)).toBe('Checking pull requests 2/9 (+1 more)');
    expect(activityQuietLine(wire({}))).toBe('Background jobs: all quiet');
  });
});

describe('collapseRuns', () => {
  it('folds consecutive uneventful runs of one job, and keeps every decision', () => {
    const quiet = [run({}), run({}), run({ repeats: 2 })];
    const acted = run({ notes: [{ at: '', level: 'action', text: 'archived feat/x' }] });
    const other = run({ kind: 'jira', label: 'Fetching your Jira issues' });
    const out = collapseRuns([...quiet, acted, run({}), other, run({ status: 'failed' }), run({ status: 'failed' })]);
    expect(out.map((r) => [r.kind, r.status, r.repeats ?? 0, r.notes.length])).toEqual([
      ['pr-watch', 'done', 4, 0], // 3 runs, one already ×3: the newest stands for 5
      ['pr-watch', 'done', 0, 1], // a decision is never folded
      ['pr-watch', 'done', 0, 0],
      ['jira', 'done', 0, 0],
      ['pr-watch', 'failed', 1, 0],
    ]);
    expect(out[0].id).toBe(quiet[0].id); // the newest one stands for them
  });
});
