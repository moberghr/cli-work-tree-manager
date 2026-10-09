import { describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import { DEFAULT_TIME_SETTINGS } from '../../../src/core/time/allocate.js';
import { buildDay, dayWire, daysWire, type TimeDeps } from '../../../src/core/time/time-days.js';
import { readDay, updateDay } from '../../../src/core/time/time-store.js';
import {
  daysBetween,
  dayWireOf,
  daysWireOf,
  localDay,
  parseEntries,
  sessionTicket,
  timeSettings,
  type TimeConfig,
} from '../../../src/core/time/time-view.js';
import { createTimeKeeper } from '../../../src/core/time/time-keeper.js';

// Each test file has its own HOME (tests/setup), so state.db here is a throwaway.
const S: TimeConfig = { ...DEFAULT_TIME_SETTINGS, gapTicket: 'SD-434', timeOffTicket: 'INT-1' };
const session = (over: Partial<WorktreeSession>): WorktreeSession =>
  ({ target: 'api', branch: 'main', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '', ...over }) as WorktreeSession;

function deps(over: Partial<TimeDeps> = {}): TimeDeps & { titles: ReturnType<typeof vi.fn> } {
  return {
    sessions: () => [
      session({ branch: 'feat/SD-3850-pos-key' }),
      session({ branch: 'fix/thing', jiraKey: 'SD-3900' }),
      session({ branch: 'chore/deps' }),
      session({ branch: 'feat/idle' }),
    ],
    minutesOn: async (s) => ({ 'feat/SD-3850-pos-key': 30, 'fix/thing': 12, 'chore/deps': 6, 'feat/idle': 0 })[s.branch] ?? 0,
    commits: async () => [
      { repo: 'api', sha: 'a1', subject: 'SD-3901: move to UTF-8' },
      { repo: 'api', sha: 'a2', subject: 'no key here' },
    ],
    jiraMoved: async () => [{ key: 'SD-3777', summary: 'Moved one', what: 'moved (now Done)' }],
    titles: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `Title of ${k}`]))),
    settings: () => S,
    now: () => Date.parse('2026-10-08T15:00:00'),
    ...over,
  } as TimeDeps & { titles: ReturnType<typeof vi.fn> };
}

describe('the pure view (time-view.ts)', () => {
  it("a session's ticket: its Jira key, else from the branch, else from its name", () => {
    expect(sessionTicket({ branch: 'feat/SD-1-x', jiraKey: 'SD-9' })).toBe('SD-9');
    expect(sessionTicket({ branch: 'feat/SD-1-x' })).toBe('SD-1');
    expect(sessionTicket({ branch: 'main', title: 'SD-2 fix' })).toBe('SD-2');
    expect(sessionTicket({ branch: 'main' })).toBeNull();
  });

  it('days between two dates, inclusive; a local day', () => {
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(localDay(Date.parse('2026-10-08T12:00:00'))).toBe('2026-10-08');
  });

  it('settings over the defaults', () => {
    expect(timeSettings({ gapTicket: 'SD-434', dayHours: 8 })).toMatchObject({ gapTicket: 'SD-434', dayHours: 8, multiplier: 5 });
    expect(timeSettings(undefined)).toEqual(DEFAULT_TIME_SETTINGS);
  });

  it('a day: the suggestion from its evidence; your rows win; a day off books the time-off ticket', () => {
    const rec = {
      day: '2026-10-08',
      evidence: { sessions: [{ sessionId: 'x', label: 'api · x', key: 'SD-1', minutes: 30 }], commits: [], jira: [] },
      titles: { 'SD-1': 'One' },
      builtAt: '2026-10-08T15:00:00Z',
      edited: null,
      dayOff: false,
    };
    const w = dayWireOf('2026-10-08', S, rec);
    expect(w).toMatchObject({ status: 'draft', total: 7.5, edited: false });
    expect(w.entries).toEqual([
      { key: 'SD-1', hours: 2.5 },
      { key: 'SD-434', hours: 5 },
    ]);
    const mine = dayWireOf('2026-10-08', S, { ...rec, edited: [{ key: 'SD-1', hours: 4 }] });
    expect(mine).toMatchObject({ status: 'edited', total: 4, unallocated: 3.5, entries: [{ key: 'SD-1', hours: 4 }] });
    expect(mine.suggested[0]).toEqual({ key: 'SD-1', hours: 2.5 });
    expect(dayWireOf('2026-10-08', S, { ...rec, dayOff: true, edited: [{ key: 'SD-1', hours: 4 }] })).toMatchObject({
      status: 'off',
      entries: [{ key: 'INT-1', hours: 7.5 }],
    });
    expect(dayWireOf('2026-10-08', S, null)).toMatchObject({ status: 'empty', builtAt: null });
    expect(dayWireOf('2026-10-10', S, null).status).toBe('not-workday');
  });

  it('the list: newest first; a weekend shows only when something happened on it', () => {
    const w = daysWireOf('2026-10-09', '2026-10-12', S, [
      {
        day: '2026-10-11',
        evidence: { sessions: [{ sessionId: 'x', label: 'x', key: 'SD-1', minutes: 5 }], commits: [], jira: [] },
        titles: {},
        builtAt: 'x',
        edited: null,
        dayOff: false,
      },
    ]);
    expect(w.days.map((d) => d.day)).toEqual(['2026-10-12', '2026-10-11', '2026-10-09']);
  });

  it('rows as sent: issue keys, hours in steps, each key once', () => {
    expect(parseEntries([{ key: ' SD-1 ', hours: 1.25 }], 0.25)).toEqual([{ key: 'SD-1', hours: 1.25 }]);
    expect(parseEntries([{ key: 'SD-1', hours: 1.3 }], 0.25)).toBeNull();
    expect(parseEntries([{ key: 'sd-1', hours: 1 }], 0.25)).toBeNull();
    expect(
      parseEntries(
        [
          { key: 'SD-1', hours: 1 },
          { key: 'SD-1', hours: 2 },
        ],
        0.25,
      ),
    ).toBeNull();
    expect(parseEntries([{ key: 'SD-1', hours: 0 }], 0.25)).toBeNull();
    expect(parseEntries('nope', 0.25)).toBeNull();
  });
});

describe('building a day (time-days.ts, state.db)', () => {
  it("gathers sessions' Claude minutes and their tickets, your commits' keys (only your projects'), what you moved; titles for the rest", async () => {
    const d = deps();
    const rec = await buildDay('2026-10-08', d);
    expect(rec.evidence.sessions.map((s) => [s.key, s.minutes])).toEqual([
      ['SD-3850', 30],
      ['SD-3900', 12],
      [null, 6],
    ]);
    expect(rec.evidence.commits.map((c) => c.keys)).toEqual([['SD-3901'], []]); // not UTF-8
    expect(rec.titles['SD-3777']).toBe('Moved one'); // from Jira's own answer, not asked again
    expect(d.titles).toHaveBeenCalledWith(expect.arrayContaining(['SD-3850', 'SD-3900', 'SD-3901', 'SD-434', 'INT-1']));
    expect(d.titles.mock.calls[0][0]).not.toContain('SD-3777');
    const w = dayWire('2026-10-08', S);
    expect(w.status).toBe('draft');
    expect(w.entries.map((e) => e.key)).toEqual(['SD-3850', 'SD-3900', 'SD-3777', 'SD-3901', 'SD-434']);
    expect(w.total).toBe(7.5);
  });

  it('a rebuild keeps your rows and your day off; a day never built takes an edit too', async () => {
    await buildDay('2026-10-07', deps());
    updateDay('2026-10-07', { edited: [{ key: 'SD-1', hours: 7.5 }] });
    await buildDay('2026-10-07', deps({ minutesOn: async () => 60 }));
    expect(readDay('2026-10-07')?.edited).toEqual([{ key: 'SD-1', hours: 7.5 }]);
    updateDay('2026-09-01', { dayOff: true });
    expect(dayWire('2026-09-01', S)).toMatchObject({ status: 'off', builtAt: null });
  });

  it('a source that fails leaves the rest: no Jira, still sessions and commits', async () => {
    const rec = await buildDay('2026-10-06', deps({ jiraMoved: async () => Promise.reject(new Error('acli missing')) }));
    expect(rec.evidence.jira).toEqual([]);
    expect(rec.evidence.sessions.length).toBe(3);
  });

  it('the list reads stored days', async () => {
    await buildDay('2026-10-05', deps()); // a Monday
    expect(daysWire('2026-10-05', '2026-10-05', S).days).toEqual([
      { day: '2026-10-05', status: 'draft', workday: true, total: 7.5, tickets: 5 },
    ]);
  });
});

describe('the keeper (time-keeper.ts)', () => {
  it('builds today and every missing workday of two weeks, once at a time; then only today', async () => {
    const now = Date.parse('2026-08-14T15:00:00'); // a Friday, weeks before the days above
    const built: string[] = [];
    const d = deps({ now: () => now, minutesOn: async () => 0, commits: async () => [], jiraMoved: async () => [] });
    const spy = { ...d, sessions: () => (built.push('x'), []) };
    const changed = vi.fn();
    const k = createTimeKeeper(spy, { changed, now: () => now });
    await Promise.all([k.run(), k.run()]); // the second joins the first
    expect(built.length).toBe(10); // 10 workdays in the 14 days to Friday, today included
    expect(changed).toHaveBeenCalledTimes(1);
    built.length = 0;
    await k.run();
    expect(built.length).toBe(1); // today only
  });
});
