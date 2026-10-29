import { describe, expect, it } from 'vitest';
import { buildUsage, usageSessions, weekStartDay, type UsageDeps } from '../../../src/core/usage/usage-source.js';
import { dayKey } from '../../../src/core/conversations/work-time-view.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import type { TokenTotals } from '../../../src/core/api-types.js';

const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime();
const DAY = 86_400_000;
const session = (branch: string): WorktreeSession => ({
  target: 'api',
  branch,
  isGroup: false,
  paths: [`/wt/${branch}`],
  createdAt: '2026-10-01T00:00:00Z',
  lastAccessedAt: '2026-10-29T00:00:00Z',
});
const t = (input: number, cached: number, output: number): TokenTotals => ({ input, cached, output });

function deps(over: Partial<UsageDeps> & { days?: Record<string, Record<string, Record<string, TokenTotals>>> } = {}): UsageDeps {
  const days = over.days ?? {};
  return {
    agents: () => [
      {
        id: 'claude',
        name: 'Claude Code',
        usage: {
          read: () => [
            {
              account: 'default',
              at: '2026-10-29T10:00:00Z',
              windows: [
                { id: 'five_hour', label: '5-hour limit', usedPercent: 60, resetsAt: new Date(NOW - 1000).toISOString() },
                { id: 'seven_day', label: 'Weekly limit', usedPercent: 18, resetsAt: new Date(NOW + DAY).toISOString() },
              ],
            },
          ],
        },
      },
      { id: 'plain', name: 'Plain' },
    ],
    sessions: () => Object.keys(days).map(session),
    // Every day it has, older ones too: buildUsage's own window is what's under test.
    tokens: async (s) => days[s.branch] ?? {},
    label: (s) => `api · ${s.branch}`,
    ...over,
  };
}

describe('buildUsage', () => {
  it('lists only agents with a usage part, their windows aged to now', async () => {
    const w = await buildUsage(deps(), NOW);
    expect(w.agents.map((a) => a.agent)).toEqual(['claude']);
    const [five, week] = w.agents[0]!.accounts[0]!.windows;
    expect(five).toMatchObject({ usedPercent: 0, reset: true }); // its reset passed since the reading
    expect(week).toMatchObject({ usedPercent: 18 });
    expect(w.at).toBe(new Date(NOW).toISOString());
  });

  it('totals today and the last 7 local days (today included), by model, and drops older days (and any after today)', async () => {
    const day = (back: number) => dayKey(NOW - back * DAY);
    const w = await buildUsage(
      deps({
        days: {
          a: {
            [day(0)]: { opus: t(10, 100, 5) },
            [day(6)]: { opus: t(20, 0, 10), haiku: t(1, 0, 1) },
            [day(7)]: { opus: t(999, 0, 999) },
            [day(-1)]: { opus: t(555, 0, 555) },
          },
        },
      }),
      NOW,
    );
    expect(w.tokens.today).toEqual(t(10, 100, 5));
    expect(w.tokens.week).toEqual(t(31, 100, 16));
    expect(w.tokens.byModel).toEqual([
      { model: 'opus', today: t(10, 100, 5), week: t(30, 100, 15) },
      { model: 'haiku', today: t(0, 0, 0), week: t(1, 0, 1) },
    ]);
  });

  it('week starts six calendar days before today', () => {
    expect(weekStartDay(NOW)).toBe('2026-10-23');
  });

  it('ranks the top five sessions by the week’s input + output, with their ids and labels', async () => {
    const today = dayKey(NOW);
    const days: Record<string, Record<string, Record<string, TokenTotals>>> = {};
    for (let i = 1; i <= 6; i++) days[`b${i}`] = { [today]: { opus: t(i * 10, 1000, i) } };
    days.empty = {};
    const w = await buildUsage(deps({ days }), NOW);
    expect(w.tokens.topSessions.map((s) => s.label)).toEqual(['api · b6', 'api · b5', 'api · b4', 'api · b3', 'api · b2']);
    expect(w.tokens.topSessions[0]).toMatchObject({ id: sessionIdFor(session('b6')), week: t(60, 1000, 6) });
  });

  it('a session whose tokens can’t be read doesn’t hide the others', async () => {
    const today = dayKey(NOW);
    const w = await buildUsage(
      deps({
        days: { ok: { [today]: { opus: t(1, 0, 1) } }, bad: {} },
        tokens: async (s) => {
          if (s.branch === 'bad') throw new Error('unreadable');
          return { [today]: { opus: t(1, 0, 1) } };
        },
      }),
      NOW,
    );
    expect(w.tokens.week).toEqual(t(1, 0, 1));
  });
});

describe('usageSessions (the sessions realUsageDeps reads)', () => {
  it('only live sessions its agent wrote in during the last 7 days', () => {
    const recent = session('recent');
    const old = session('old');
    const archived = { ...session('archived'), archivedAt: '2026-10-28T00:00:00Z' };
    const edge = session('edge');
    const lastWrite: Record<string, number> = { recent: NOW - DAY, old: NOW - 8 * DAY, archived: NOW, edge: NOW - 7 * DAY };
    const got = usageSessions([recent, old, archived, edge], (s) => lastWrite[s.branch]!, NOW);
    expect(got.map((s) => s.branch)).toEqual(['recent', 'edge']);
  });
});
