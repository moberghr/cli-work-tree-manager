import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_SETTINGS } from '../../../src/core/time/allocate.js';
import { buildDay, monthWire, type TimeDeps } from '../../../src/core/time/time-days.js';
import { readDay, updateDay } from '../../../src/core/time/time-store.js';
import { dayWireOf, describeTimeDay, listFrom, timeRange, type TimeConfig, type TimeDayRecord } from '../../../src/core/time/time-view.js';
import { addMonths, isMonth, leftOutWhy, monthRange, monthWireOf, needsBuild } from '../../../src/core/time/time-month.js';
import { createMonthGather } from '../../../src/core/time/month-gather.js';
import { createTimeKeeper } from '../../../src/core/time/time-keeper.js';

// Each test file has its own HOME (tests/setup), so state.db here is a throwaway.
const S: TimeConfig = { ...DEFAULT_TIME_SETTINGS, gapTicket: 'OPS-1', timeOffTicket: 'HR-1' };

/** A gathered day: Claude time on `key` (the gap ticket takes the rest of the day). */
const rec = (day: string, over: Partial<TimeDayRecord> = {}, key = 'APP-1', minutes = 30): TimeDayRecord => ({
  day,
  evidence: { sessions: [{ sessionId: 's', label: 'api · feat/x', key, minutes }], commits: [], jira: [] },
  titles: { 'APP-1': 'One', 'APP-2': 'Two', 'OPS-1': 'Meetings', 'HR-1': 'Time off' },
  builtAt: new Date(Date.parse(`${day}T12:00:00`) + 24 * 3600_000).toISOString(), // the next day, local: after it ended in any zone
  edited: null,
  dayOff: false,
  ...over,
});

const deps = (over: Partial<TimeDeps> = {}): TimeDeps => ({
  sessions: () => [],
  minutesOn: async () => 0,
  commits: async () => [],
  jiraMoved: async () => [],
  titles: async () => ({}),
  settings: () => S,
  ...over,
});

describe('how far back the tab reaches', () => {
  it('the whole month, or catchUpDays when that reaches further', () => {
    expect(listFrom('2026-10-30', 14)).toBe('2026-10-01'); // the reason: the month to post at its end
    expect(listFrom('2026-10-09', 14)).toBe('2026-09-26'); // early in a month: two weeks back
    expect(listFrom('2026-10-30', 45)).toBe('2026-09-16');
    expect(listFrom('2026-10-30', 500)).toBe('2026-07-31'); // a quarter at most
    expect(timeRange({}, '2026-10-30', 14)).toEqual({ from: '2026-10-01', to: '2026-10-30' });
  });

  it('the keeper builds every missing day of the month, though catchUpDays is two weeks', async () => {
    const now = Date.parse('2026-03-30T15:00:00'); // a Monday
    const built = new Set<string>();
    const d = deps({ now: () => now, minutesOn: async (_s, day) => (built.add(day), 0), sessions: () => [{} as never] });
    await createTimeKeeper(d, { changed: vi.fn(), now: () => now }).run();
    expect([...built].sort()[0]).toBe('2026-03-01');
    expect(built.size).toBe(30);
  });
});

describe('months', () => {
  it('a month up to today; one not started is none', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(monthRange('2026-10', '2026-10-30')).toEqual({ from: '2026-10-01', to: '2026-10-30' });
    expect(monthRange('2026-09', '2026-10-30')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthRange('2026-02', '2026-10-30')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2026-11', '2026-10-30')).toBeNull();
    expect(monthRange('nope', '2026-10-30')).toBeNull();
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
  });

  it('a day wants gathering when never gathered, or gathered before it ended', () => {
    expect(needsBuild('2026-10-08', undefined)).toBe(true);
    expect(needsBuild('2026-10-08', '')).toBe(true);
    expect(needsBuild('2026-10-08', new Date('2026-10-08T15:00:00').toISOString())).toBe(true);
    expect(needsBuild('2026-10-08', new Date('2026-10-09T08:00:00').toISOString())).toBe(false);
  });
});

describe('the Month view (monthWireOf)', () => {
  // October 2026: Thu 1, Fri 2, … Fri 30 is "today".
  const records = [
    rec('2026-10-01', { posted: { at: 'x', entries: [], worklogs: [] } }), // posted, then the suggestion moved: changed
    rec('2026-10-02'),
    rec('2026-10-05', { dayOff: true }),
    rec('2026-10-06', { edited: [{ key: 'APP-2', hours: 6 }] }), // short
    rec('2026-10-07', { edited: [{ key: 'NEW-1', hours: 7.5 }] }),
    rec('2026-10-08', {}, 'APP-2'),
    rec('2026-10-10', {}, 'APP-1', 60), // a Saturday with work on it
    rec('2026-10-30'),
  ];
  const settings: TimeConfig = { ...S, hints: { 'NEW-1': { words: ['new'], placeholder: true, summary: 'New thing' } } as never };
  const w = monthWireOf('2026-10', '2026-10-30', settings, records);

  it('every workday up to today, oldest first; a weekend only with something on it', () => {
    expect(w.days[0].day).toBe('2026-10-01');
    expect(w.days[w.days.length - 1]).toMatchObject({ day: '2026-10-30', today: true });
    expect(w.days.map((d) => d.day)).toContain('2026-10-10');
    expect(w.days.map((d) => d.day)).not.toContain('2026-10-11');
    expect(w.days.filter((d) => d.workday)).toHaveLength(22);
  });

  it('which days go with the month, and why the rest stay', () => {
    const why = Object.fromEntries(w.plan.leftOut.map((l) => [l.day, l.why]));
    expect(why['2026-10-30']).toBe('today');
    expect(why['2026-10-07']).toBe('placeholder');
    expect(why['2026-10-09']).toBe('not-gathered');
    expect(w.plan.days).toEqual(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-08']);
    // A weekend with work on it: its suggestion is a whole day, so it goes only with rows you saved.
    expect(why['2026-10-10']).toBe('not-workday');
    const saved = monthWireOf('2026-10', '2026-10-30', S, [rec('2026-10-10', { edited: [{ key: 'APP-1', hours: 2 }] })]);
    expect(saved.plan.days).toEqual(['2026-10-10']);
    expect(w.plan.short).toEqual([{ day: '2026-10-06', total: 6 }]);
    expect(w.missing).toBe(29 - 7); // every past day of the month (weekends too) not gathered
  });

  it('what goes, per ticket: time off and the gap ticket last; the grid has every ticket, placeholders marked', () => {
    expect(w.plan.tickets.map((t) => t.key)).toEqual(['APP-2', 'APP-1', 'HR-1', 'OPS-1']); // most hours first
    expect(w.plan.tickets.find((t) => t.key === 'HR-1')).toMatchObject({ hours: 7.5, days: 1, title: 'Time off' });
    expect(w.plan.total).toBe(Math.round(w.plan.tickets.reduce((n, t) => n + t.hours, 0) * 100) / 100);
    expect(w.tickets.find((t) => t.key === 'NEW-1')).toMatchObject({ placeholder: true });
  });

  it('a day already in Tempo stays out; one with nothing to post too', () => {
    const posted = rec('2026-10-02');
    const p = monthWireOf('2026-10', '2026-10-30', S, [posted]);
    const entries = p.days.find((d) => d.day === '2026-10-02')!.entries;
    const again = monthWireOf('2026-10', '2026-10-30', S, [{ ...posted, posted: { at: 'x', entries, worklogs: [] } }]);
    expect(again.plan.leftOut).toContainEqual({ day: '2026-10-02', why: 'posted' });
    expect(
      leftOutWhy({
        day: 'x',
        status: 'draft',
        workday: true,
        dayOff: false,
        today: false,
        edited: false,
        why: {},
        entries: [],
        total: 0,
        placeholders: [],
      }),
    ).toBe('empty');
  });

  it('a month that has not started is empty', () => {
    expect(monthWireOf('2026-11', '2026-10-30', S, []).days).toEqual([]);
  });
});

describe("a day's rows say how they got their hours (dayWireOf why)", () => {
  // 51 min on a branch naming no ticket, placed by the AI step; three commits too.
  const day = rec('2026-10-05', {
    evidence: {
      sessions: [{ sessionId: 's', label: 'straumur · fix/settlement-flow', key: 'APP-1', minutes: 51, guessed: true }],
      commits: [1, 2, 3].map((n) => ({ repo: 'web', sha: `c${n}`, subject: 'settle', keys: ['APP-1'], guessed: true as const })),
      jira: [],
    },
  });

  it('the arithmetic, then where it came from — and that the AI step placed it', () => {
    const w = dayWireOf('2026-10-05', S, day);
    expect(w.why['APP-1']).toBe(
      '51 min of Claude × 5 = 4.25 h → 4.25 h. From: fix/settlement-flow, 3 commits — placed by the AI step (none of it named the ticket)',
    );
    expect(w.why['OPS-1']).toBe('the rest of the 7.5 h day → 3.25 h');
    expect(describeTimeDay(w)).toContain('Why APP-1: 51 min of Claude × 5 = 4.25 h');
  });

  it('your own rows say so, with what work had suggested', () => {
    const w = dayWireOf('2026-10-05', S, {
      ...day,
      edited: [
        { key: 'APP-1', hours: 2 },
        { key: 'APP-9', hours: 5.5 },
      ],
    });
    expect(w.why['APP-1']).toMatch(/^Your hours\. work suggested: 51 min of Claude/);
    expect(w.why['APP-9']).toBe('Your hours (work suggested none for it).');
  });

  it("the Month view's days carry it, for the grid's cells", () => {
    expect(monthWireOf('2026-10', '2026-10-30', S, [day]).days.find((d) => d.day === '2026-10-05')!.why['APP-1']).toMatch(/^51 min/);
  });
});

describe('Gather these days (month-gather.ts)', () => {
  it("builds the month's past days not gathered, one after another, telling the tab; then says there's nothing to gather", async () => {
    await buildDay('2026-05-04', deps()); // gathered already (and after it ended: built now)
    updateDay('2026-05-05', { edited: [{ key: 'APP-1', hours: 7.5 }] }); // only edited
    const changed = vi.fn();
    const g = createMonthGather(deps(), { changed, now: () => Date.parse('2026-05-07T12:00:00') });
    expect(g.start('2026-05')).toBe(true);
    expect(g.start('2026-05')).toBe(false); // under way
    expect(g.state('2026-05').gathering).toBe(true);
    await g.done('2026-05');
    expect(g.state('2026-05')).toEqual({ gathering: false, error: null });
    expect(changed.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-05', '2026-05-06']),
    );
    expect(changed.mock.calls.map((c) => c[0])).not.toContain('2026-05-07'); // today is the keeper's
    expect(readDay('2026-05-05')?.edited).toEqual([{ key: 'APP-1', hours: 7.5 }]); // your rows kept
    expect(monthWire('2026-05', '2026-05-07', S).missing).toBe(0);
    expect(g.start('2026-05')).toBe(false);
  });

  it('a day that fails leaves the rest gathered, and the month says which', async () => {
    let n = 0;
    const failing = deps({
      sessions: () => {
        if (++n === 2) throw new Error('database is locked');
        return [];
      },
    });
    const g = createMonthGather(failing, { changed: vi.fn(), now: () => Date.parse('2026-04-04T12:00:00') });
    expect(g.start('2026-04')).toBe(true);
    await g.done('2026-04');
    expect(g.state('2026-04').error).toMatch(/^1 of 3 days not gathered — 2026-04-02: database is locked$/);
  });
});
