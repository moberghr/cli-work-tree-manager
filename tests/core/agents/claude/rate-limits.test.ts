import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { accountOf, parseClaudeRateLimits } from '../../../../src/core/agents/claude/rate-limits.js';

describe('parseClaudeRateLimits', () => {
  it('reads the 5-hour and weekly windows', () => {
    const got = parseClaudeRateLimits({
      seven_day: { used_percentage: 18, resets_at: 1_800_000_000 },
      five_hour: { used_percentage: 42.46, resets_at: 1_799_990_000 },
    });
    expect(got.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ['five_hour', '5-hour limit', 42.5],
      ['seven_day', 'Weekly limit', 18],
    ]);
  });

  it('takes reset times as epoch seconds, milliseconds or a date string', () => {
    const iso = '2027-01-15T08:00:00.000Z';
    const ms = Date.parse(iso);
    const got = parseClaudeRateLimits({
      five_hour: { used_percentage: 1, resets_at: ms / 1000 },
      seven_day: { used_percentage: 2, resets_at: ms },
      seven_day_opus: { used_percentage: 3, resets_at: iso },
      '3_day': { used_percentage: 4, resets_at: 'nonsense' },
      '2_hour': { used_percentage: 5 },
    });
    expect(got.map((w) => w.resetsAt)).toEqual([iso, iso, null, null, iso]);
  });

  it('labels extra windows from their key', () => {
    const got = parseClaudeRateLimits({
      seven_day_sonnet: { used_percentage: 10 },
      '12_hour': { used_percentage: 20 },
      '3_day': { used_percentage: 30 },
    });
    expect(got.map((w) => w.label)).toEqual(['12-hour limit', '3-day limit', 'Weekly Sonnet limit']);
  });

  it('puts the spend limit last, from its percent or from dollars', () => {
    const a = parseClaudeRateLimits({ spend_limit: { used_percentage: 33 }, five_hour: { used_percentage: 5 } });
    expect(a.map((w) => w.id)).toEqual(['five_hour', 'spend_limit']);
    expect(a[1]).toMatchObject({ label: 'Spend limit', usedPercent: 33 });
    const b = parseClaudeRateLimits({ spend_limit: { used_usd: 5, limit_usd: 20, period: 'month', resets_at: 1_800_000_000 } });
    expect(b[0]).toMatchObject({ usedPercent: 25 });
    expect(b[0]!.resetsAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it('skips a spend limit with nothing to compute', () => {
    expect(parseClaudeRateLimits({ spend_limit: { used_usd: 5 } })).toEqual([]);
    expect(parseClaudeRateLimits({ spend_limit: { used_usd: 5, limit_usd: 0 } })).toEqual([]);
  });

  it('clamps the percent to 0..100', () => {
    const got = parseClaudeRateLimits({ five_hour: { used_percentage: 140 }, seven_day: { used_percentage: -3 } });
    expect(got.map((w) => w.usedPercent)).toEqual([100, 0]);
  });

  it('skips malformed entries without throwing', () => {
    for (const raw of [null, undefined, 'x', 7, [], {}]) expect(parseClaudeRateLimits(raw)).toEqual([]);
    const got = parseClaudeRateLimits({
      five_hour: 'high',
      seven_day: { used_percentage: 'a lot' },
      seven_day_opus: null,
      '1_day': { used_percentage: Number.NaN },
      '2_day': { used_percentage: 9, resets_at: 1_800_000_000 },
    });
    expect(got.map((w) => w.id)).toEqual(['2_day']);
  });
});

describe('accountOf', () => {
  it('is default without a config folder', () => {
    expect(accountOf(undefined)).toBe('default');
    expect(accountOf('')).toBe('default');
  });

  it('is default for the folder Claude uses anyway (~/.claude)', () => {
    expect(accountOf(path.join(os.homedir(), '.claude'))).toBe('default');
    expect(accountOf(path.join(os.homedir(), 'x', '..', '.claude'))).toBe('default');
    if (process.platform === 'win32') expect(accountOf(path.join(os.homedir(), '.CLAUDE'))).toBe('default');
  });

  it('names a config folder by a short hash of its resolved path', () => {
    const a = accountOf('/tmp/claude-a');
    expect(a).toMatch(/^cfg-[0-9a-f]{8}$/);
    expect(accountOf('/tmp/claude-a')).toBe(a);
    expect(accountOf('/tmp/x/../claude-a')).toBe(a);
    expect(accountOf('/tmp/claude-b')).not.toBe(a);
  });
});
