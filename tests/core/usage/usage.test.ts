import { describe, it, expect } from 'vitest';
import { agedWindow, meterWindow, formatTokens, resetPhrase, type AgentUsage, type UsageWindow } from '../../../src/core/usage/usage.js';

const win = (id: string, usedPercent: number, resetsAt: string | null): UsageWindow => ({ id, label: id, usedPercent, resetsAt });

describe('agedWindow', () => {
  const now = Date.parse('2027-01-15T12:00:00Z');

  it('starts a window over once its reset time has passed', () => {
    expect(agedWindow(win('five_hour', 80, '2027-01-15T11:00:00Z'), now)).toMatchObject({ usedPercent: 0, reset: true });
  });

  it('keeps a window that has not reset, or has no reset time', () => {
    const future = win('a', 80, '2027-01-15T13:00:00Z');
    expect(agedWindow(future, now)).toBe(future);
    const unknown = win('b', 80, null);
    expect(agedWindow(unknown, now)).toBe(unknown);
  });
});

describe('meterWindow', () => {
  const now = Date.parse('2027-01-15T12:00:00Z');
  const agent = (id: string, windows: UsageWindow[], account = 'default'): AgentUsage => ({
    agent: id,
    name: id.toUpperCase(),
    accounts: [{ account, at: new Date(now).toISOString(), windows }],
  });

  it('is null with nothing recorded', () => {
    expect(meterWindow([], now)).toBeNull();
    expect(meterWindow([agent('claude', [])], now)).toBeNull();
  });

  it('picks the highest percent across agents and accounts', () => {
    const got = meterWindow(
      [
        agent('claude', [win('five_hour', 30, '2027-01-15T15:00:00Z'), win('seven_day', 55, '2027-01-20T00:00:00Z')]),
        agent('codex', [win('x', 40, null)], 'work'),
      ],
      now,
    );
    expect(got).toMatchObject({ agent: 'claude', name: 'CLAUDE', account: 'default', window: { id: 'seven_day' } });
  });

  it('counts a window that has reset as 0', () => {
    const got = meterWindow(
      [agent('claude', [win('five_hour', 90, '2027-01-15T11:00:00Z'), win('seven_day', 10, '2027-01-20T00:00:00Z')])],
      now,
    );
    expect(got?.window.id).toBe('seven_day');
  });

  it('breaks a tie with the window that resets later', () => {
    const got = meterWindow(
      [agent('claude', [win('five_hour', 50, '2027-01-15T15:00:00Z'), win('seven_day', 50, '2027-01-20T00:00:00Z')])],
      now,
    );
    expect(got?.window.id).toBe('seven_day');
  });
});

describe('formatTokens', () => {
  it('sizes', () => {
    expect([273, 1700, 48_000, 1_600_000, 48_000_000, 1_200_000_000].map(formatTokens)).toEqual([
      '273',
      '1.7k',
      '48k',
      '1.6M',
      '48M',
      '1.2B',
    ]);
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(999_900)).toBe('1M');
  });
});

describe('resetPhrase', () => {
  const now = new Date(2026, 9, 29, 12, 0).getTime();
  it('a clock time within a day, a weekday after', () => {
    expect(resetPhrase(new Date(2026, 9, 29, 15, 10).toISOString(), now)).toBe('resets 15:10');
    expect(resetPhrase(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe('resets Mon 09:00');
  });
  it('nothing for null or an invalid time', () => {
    expect(resetPhrase(null, now)).toBe('');
    expect(resetPhrase('nope', now)).toBe('');
  });
});
