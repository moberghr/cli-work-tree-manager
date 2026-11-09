import { describe, expect, it } from 'vitest';
import { cellEdit, leftOutText, monthLabel, monthOf, monthPostSummary } from '../../src/web/src/state/time-month.js';

const label = (d: string) => d.slice(5);

describe("the Month view's wording (state/time-month.ts)", () => {
  it('how posting the month went, in a line: hours of the days posted, each failure named, a stop said', () => {
    expect(monthPostSummary([{ day: '2026-10-01', hours: 7.5 }], 1, label)).toBe('1 day posted to Tempo, 7.5 h.');
    expect(
      monthPostSummary(
        [
          { day: '2026-10-01', hours: 7.5 },
          { day: '2026-10-02', hours: 7.5, failed: [{ key: 'API-204', error: 'no permission' }] },
          { day: '2026-10-05', hours: 0, error: 'Tempo list: 401 Unauthorized' },
        ],
        5,
        label,
      ),
    ).toBe(
      '2 days posted to Tempo, 15 h. 10-02: API-204 refused (no permission). 10-05 failed: Tempo list: 401 Unauthorized. Stopped: 2 not posted.',
    );
  });

  it('why a day stays out; the month by name', () => {
    expect(leftOutText('placeholder')).toMatch(/Jira/);
    expect(leftOutText('not-workday')).toMatch(/save its rows/);
    expect(monthOf('2026-10-30')).toBe('2026-10');
    expect(monthLabel('2026-10')).toMatch(/2026/);
  });

  it("a Month cell typed in: the day's rows with that ticket changed, added or taken out; not hours is said", () => {
    const rows = [
      { key: 'A-1', hours: 2.5 },
      { key: 'GAP-1', hours: 5 },
    ];
    expect(cellEdit(rows, 'A-1', '3', 0.25)).toEqual({
      entries: [
        { key: 'A-1', hours: 3 },
        { key: 'GAP-1', hours: 5 },
      ],
    });
    expect(cellEdit(rows, 'A-1', '2,5', 0.25)).toBeNull(); // unchanged (a comma reads as a point)
    expect(cellEdit(rows, 'A-2', '1', 0.25)).toEqual({ entries: [...rows, { key: 'A-2', hours: 1 }] });
    expect(cellEdit(rows, 'A-1', '', 0.25)).toEqual({ entries: [{ key: 'GAP-1', hours: 5 }] });
    expect(cellEdit(rows, 'A-1', '0', 0.25)).toEqual({ entries: [{ key: 'GAP-1', hours: 5 }] });
    expect(cellEdit(rows, 'A-1', 'two', 0.25)).toEqual({ error: 'Not hours: two' });
    expect(cellEdit(rows, 'A-1', '1.1', 0.25)).toEqual({ error: 'Hours go in steps of 0.25: 1.1' });
  });
});
