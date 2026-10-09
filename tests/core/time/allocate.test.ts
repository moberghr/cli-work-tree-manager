import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_SETTINGS, isWorkday, issueKeys, suggestDay, totalHours, type TimeSettings } from '../../../src/core/time/allocate.js';

const S: TimeSettings = { ...DEFAULT_TIME_SETTINGS, gapTicket: 'SD-434', timeOffTicket: 'INT-1' };

describe("effort mode (time.effort: the timesheet tool's build --effort)", () => {
  it('Claude minutes 1:1 in quarter hours, no minimum beyond a step, a ticket only touched gets nothing; the gap ticket the rest', () => {
    const r = suggestDay(
      [
        { key: 'SD-1', minutes: 95 }, // 1.58 h → 1.5
        { key: 'SD-2', minutes: 10 }, // 0.17 h → the nearest quarter, 0.25 (as the tool's _round_15)
        { key: 'SD-3', minutes: 20 }, // 0.33 h → 0.25 (no 0.5 minimum)
        { key: 'SD-4', minutes: 0 }, // a commit only: nothing
        { key: 'SD-5', minutes: 5 }, // 0.08 h → under half a step: nothing
      ],
      { ...S, effort: true },
    );
    expect(r.entries).toEqual([
      { key: 'SD-1', hours: 1.5 },
      { key: 'SD-2', hours: 0.25 },
      { key: 'SD-3', hours: 0.25 },
      { key: 'SD-434', hours: 5.5 },
    ]);
  });
});

describe('suggestDay (the timesheet rules)', () => {
  it('Claude minutes × 5, in quarter hours, the rest of 7.5 h to the gap ticket', () => {
    const r = suggestDay(
      [
        { key: 'SD-1', minutes: 30 },
        { key: 'SD-2', minutes: 12 },
      ],
      S,
    );
    expect(r.entries).toEqual([
      { key: 'SD-1', hours: 2.5 },
      { key: 'SD-2', hours: 1 },
      { key: 'SD-434', hours: 4 },
    ]);
    expect(totalHours(r.entries)).toBe(7.5);
    expect(r.unallocated).toBe(0);
  });

  it('more than the cap: scaled down to 7 h, the gap ticket keeps its half hour', () => {
    const r = suggestDay(
      [
        { key: 'SD-1', minutes: 120 },
        { key: 'SD-2', minutes: 60 },
      ],
      S,
    );
    expect(totalHours(r.entries.filter((e) => e.key !== 'SD-434'))).toBe(7);
    expect(r.entries.at(-1)).toEqual({ key: 'SD-434', hours: 0.5 });
    expect(r.entries[0].hours).toBeGreaterThan(r.entries[1].hours);
  });

  it('a ticket touched with no measured time (a commit, a transition) gets the minimum', () => {
    const r = suggestDay([{ key: 'SD-9', minutes: 0 }], S);
    expect(r.entries).toEqual([
      { key: 'SD-9', hours: 0.5 },
      { key: 'SD-434', hours: 7 },
    ]);
  });

  it('a sliver under a quarter hour is dropped; one over it is raised to the minimum', () => {
    const r = suggestDay(
      [
        { key: 'SD-1', minutes: 2 },
        { key: 'SD-2', minutes: 4 },
      ],
      S,
    ); // ×5: 10 min, 20 min
    expect(r.entries.map((e) => e.key)).toEqual(['SD-2', 'SD-434']);
    expect(r.entries[0].hours).toBe(0.5);
  });

  it("never over the day with many tickets (the tool's minimums could push it past 7.5 h)", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `SD-${i + 1}`, minutes: 1 }));
    const r = suggestDay(many, S);
    expect(totalHours(r.entries)).toBe(7.5);
    expect(r.entries.every((e) => e.hours >= 0.5)).toBe(true);
  });

  it('trims from the biggest, not from one entry alone', () => {
    // 3 tickets × 2.5 h = 7.5 h raw, room 7 h: the biggest gives a quarter, then the next.
    const r = suggestDay(
      [
        { key: 'A-1', minutes: 31 },
        { key: 'B-1', minutes: 30 },
        { key: 'C-1', minutes: 30 },
      ],
      S,
    );
    const tickets = r.entries.filter((e) => e.key !== 'SD-434');
    expect(totalHours(tickets)).toBe(7);
    expect(Math.max(...tickets.map((e) => e.hours)) - Math.min(...tickets.map((e) => e.hours))).toBeLessThanOrEqual(0.25);
  });

  it("the gap ticket's own sessions go into what it gets; time on one ticket from two sessions adds up", () => {
    const r = suggestDay(
      [
        { key: 'SD-434', minutes: 60 },
        { key: 'SD-1', minutes: 6 },
        { key: 'SD-1', minutes: 6 },
      ],
      S,
    );
    expect(r.entries).toEqual([
      { key: 'SD-1', hours: 1 },
      { key: 'SD-434', hours: 6.5 },
    ]);
  });

  it('no gap ticket set: the rest is unallocated; a day off books the time-off ticket, or nothing', () => {
    const r = suggestDay([{ key: 'SD-1', minutes: 30 }], { ...S, gapTicket: null });
    expect(r).toEqual({ entries: [{ key: 'SD-1', hours: 2.5 }], unallocated: 5 });
    expect(suggestDay([], S, { dayOff: true })).toEqual({ entries: [{ key: 'INT-1', hours: 7.5 }], unallocated: 0 });
    expect(suggestDay([], { ...S, timeOffTicket: null }, { dayOff: true })).toEqual({ entries: [], unallocated: 7.5 });
  });

  it('nothing worked: the whole day to the gap ticket', () => {
    expect(suggestDay([], S).entries).toEqual([{ key: 'SD-434', hours: 7.5 }]);
  });
});

describe('workdays and issue keys', () => {
  it('weekends and holidays are not workdays', () => {
    expect(isWorkday('2026-10-09', S)).toBe(true); // a Friday
    expect(isWorkday('2026-10-10', S)).toBe(false); // Saturday
    expect(isWorkday('2026-10-09', { holidays: ['2026-10-09'] })).toBe(false);
  });

  it('keys from text, only of known projects when given', () => {
    expect(issueKeys('feat/SD-3850-pos-key and SD-3850 again, SSD-12')).toEqual(['SD-3850', 'SSD-12']);
    expect(issueKeys('Move to UTF-8 for SD-1', new Set(['SD']))).toEqual(['SD-1']);
    expect(issueKeys('no keys here')).toEqual([]);
  });
});
