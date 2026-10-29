import { describe, expect, it } from 'vitest';
import type { UsageWire } from '../../src/core/api-types.js';
import { ageText, meterView, stale, windowRows } from '../../src/web/src/state/usage-view.js';

const NOW = new Date(2026, 9, 29, 12, 0).getTime();
const min = (n: number) => new Date(NOW - n * 60_000).toISOString();
const empty = { input: 0, cached: 0, output: 0 };
const wire = (agents: UsageWire['agents']): UsageWire => ({
  agents,
  tokens: { today: empty, week: empty, byModel: [], topSessions: [] },
  at: min(0),
});

const claude = (windows: Array<[string, string, number, string | null]>, at = min(1)): UsageWire['agents'] => [
  {
    agent: 'claude',
    name: 'Claude Code',
    accounts: [{ account: 'a1', at, windows: windows.map(([id, label, usedPercent, resetsAt]) => ({ id, label, usedPercent, resetsAt })) }],
  },
];

describe('meterView', () => {
  it('the window nearest its limit, with a title', () => {
    const reset = new Date(2026, 10, 2, 9, 0).toISOString();
    const v = meterView(
      wire(
        claude([
          ['five_hour', '5-hour limit', 12, null],
          ['seven_day', 'Weekly limit', 18.4, reset],
        ]),
      ),
      NOW,
    );
    expect(v).toEqual({ text: 'Claude wk 18%', level: 'ok', title: 'Weekly limit 18% · resets Mon 09:00 · read 1 min ago' });
  });

  it('warn from 70, full from 90', () => {
    expect(meterView(wire(claude([['five_hour', '5-hour limit', 70, null]])), NOW).level).toBe('warn');
    expect(meterView(wire(claude([['five_hour', '5-hour limit', 90, null]])), NOW).level).toBe('full');
  });

  it('short names for spend and unknown windows; other agents keep their name', () => {
    const other: UsageWire['agents'] = [
      {
        agent: 'x',
        name: 'Codex',
        accounts: [{ account: 'a', at: min(0), windows: [{ id: 'monthly', label: 'Monthly limit', usedPercent: 5, resetsAt: null }] }],
      },
    ];
    expect(meterView(wire(other), NOW).text).toBe('Codex Monthly 5%');
    expect(meterView(wire(claude([['spend_limit', 'Spend limit', 40, null]])), NOW).text).toBe('Claude spend 40%');
  });

  it('a window past its reset reads 0', () => {
    expect(meterView(wire(claude([['five_hour', '5-hour limit', 95, min(5)]])), NOW).text).toBe('Claude 5h 0%');
  });

  it('a failed fetch with nothing shown yet: "Usage", and why in the title', () => {
    const v = meterView(null, NOW, 'HTTP 500');
    expect(v).toEqual({ text: 'Usage', level: 'none', title: 'Usage unavailable: HTTP 500' });
  });

  it('a failed fetch with numbers already shown keeps them', () => {
    const w = wire(claude([['five_hour', '5-hour limit', 42, null]]));
    expect(meterView(w, NOW, 'HTTP 500').text).toBe(meterView(w, NOW).text);
  });

  it('no reading: "Usage" and why', () => {
    for (const w of [null, wire([]), wire([{ agent: 'claude', name: 'Claude Code', accounts: [] }])]) {
      const v = meterView(w, NOW);
      expect(v.text).toBe('Usage');
      expect(v.level).toBe('none');
      expect(v.title).toContain('status line');
    }
  });
});

describe('ageText / stale', () => {
  it('words', () => {
    expect(ageText(min(0), NOW)).toBe('just now');
    expect(ageText(min(3), NOW)).toBe('3 min ago');
    expect(ageText(min(120), NOW)).toBe('2 h ago');
    expect(ageText(min(30 * 60), NOW)).toBe('yesterday');
    expect(ageText(min(4 * 24 * 60), NOW)).toBe('4 days ago');
    expect(ageText('nope', NOW)).toBe('');
  });
  it('stale after 6 hours', () => {
    expect(stale(min(5 * 60), NOW)).toBe(false);
    expect(stale(min(7 * 60), NOW)).toBe(true);
  });
});

describe('windowRows', () => {
  it('rows with level and reset phrase', () => {
    const rows = windowRows(
      { windows: [{ id: 'five_hour', label: '5-hour limit', usedPercent: 72.4, resetsAt: new Date(2026, 9, 29, 15, 10).toISOString() }] },
      NOW,
    );
    expect(rows).toEqual([{ label: '5-hour limit', pct: 72, level: 'warn', reset: 'resets 15:10' }]);
  });
});
