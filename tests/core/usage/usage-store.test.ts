import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/core/platform/logger.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/platform/logger.js')>()),
  debugLog: (_level: string, ...args: unknown[]) => void logged.push(args.join(' ')),
}));
import { readReadings, recordReading, usageDir } from '../../../src/core/usage/usage-store.js';
import type { UsageWindow } from '../../../src/core/usage/usage.js';

const windows = (percent: number): UsageWindow[] => [
  { id: 'five_hour', label: '5-hour limit', usedPercent: percent, resetsAt: '2027-01-15T15:00:00.000Z' },
];
const T0 = Date.parse('2027-01-15T12:00:00Z');

beforeEach(() => {
  fs.rmSync(usageDir(), { recursive: true, force: true });
  logged.length = 0;
});

describe('recordReading / readReadings', () => {
  it('round-trips a reading', () => {
    expect(recordReading('claude', 'default', windows(40), T0)).toBe(true);
    expect(readReadings('claude')).toEqual([{ account: 'default', at: new Date(T0).toISOString(), windows: windows(40) }]);
  });

  it('writes nothing for an empty reading', () => {
    expect(recordReading('claude', 'default', [], T0)).toBe(false);
    expect(readReadings('claude')).toEqual([]);
  });

  it('does not rewrite an unchanged reading within a minute', () => {
    recordReading('claude', 'default', windows(40), T0);
    expect(recordReading('claude', 'default', windows(40), T0 + 30_000)).toBe(false);
    expect(readReadings('claude')[0]!.at).toBe(new Date(T0).toISOString());
  });

  it('refreshes the time of an unchanged reading after a minute', () => {
    recordReading('claude', 'default', windows(40), T0);
    expect(recordReading('claude', 'default', windows(40), T0 + 61_000)).toBe(true);
    expect(readReadings('claude')[0]!.at).toBe(new Date(T0 + 61_000).toISOString());
  });

  it('writes a changed reading at once', () => {
    recordReading('claude', 'default', windows(40), T0);
    expect(recordReading('claude', 'default', windows(41), T0 + 1000)).toBe(true);
    expect(readReadings('claude')[0]!.windows[0]!.usedPercent).toBe(41);
  });

  it('keeps the higher percent of the same window (an idle Claude redraws an older figure)', () => {
    recordReading('claude', 'default', windows(40), T0);
    recordReading('claude', 'default', windows(35), T0 + 1000);
    expect(readReadings('claude')[0]!.windows[0]!.usedPercent).toBe(40);
  });

  it('takes a lower percent once the window has reset (another reset time)', () => {
    recordReading('claude', 'default', windows(90), T0);
    const next: UsageWindow[] = [{ id: 'five_hour', label: '5-hour limit', usedPercent: 3, resetsAt: '2027-01-15T20:00:00.000Z' }];
    expect(recordReading('claude', 'default', next, T0 + 1000)).toBe(true);
    expect(readReadings('claude')[0]!.windows).toEqual(next);
  });

  it('a window with no reset time takes the new figure', () => {
    const w = (p: number): UsageWindow[] => [{ id: 'spend_limit', label: 'Spend limit', usedPercent: p, resetsAt: null }];
    recordReading('claude', 'default', w(50), T0);
    recordReading('claude', 'default', w(10), T0 + 1000);
    expect(readReadings('claude')[0]!.windows[0]!.usedPercent).toBe(10);
  });

  it('a reading that cannot be written is logged, and recordReading still returns false', () => {
    fs.mkdirSync(path.dirname(usageDir()), { recursive: true });
    fs.writeFileSync(usageDir(), 'a file where the folder goes');
    try {
      expect(recordReading('claude', 'default', windows(1), T0)).toBe(false);
      expect(logged.some((l) => l.includes('[usage] reading not kept'))).toBe(true);
    } finally {
      fs.rmSync(usageDir(), { force: true });
    }
  });

  it('keeps accounts and agents apart, sorted by account', () => {
    recordReading('claude', 'cfg-bbbbbbbb', windows(2), T0);
    recordReading('claude', 'default', windows(1), T0);
    recordReading('codex', 'default', windows(3), T0);
    expect(readReadings('claude').map((r) => r.account)).toEqual(['cfg-bbbbbbbb', 'default']);
    expect(readReadings('codex')).toHaveLength(1);
  });

  it('skips files that are not readings, and replaces a bad one on the next record', () => {
    recordReading('claude', 'default', windows(1), T0);
    fs.writeFileSync(path.join(usageDir(), 'claude-broken.json'), '{ not json');
    fs.writeFileSync(path.join(usageDir(), 'claude-shape.json'), JSON.stringify({ at: 'x', windows: [{ id: 1 }] }));
    expect(readReadings('claude').map((r) => r.account)).toEqual(['default']);
    expect(recordReading('claude', 'broken', windows(5), T0)).toBe(true);
    expect(readReadings('claude').map((r) => r.account)).toEqual(['broken', 'default']);
  });

  it('is empty when the folder does not exist', () => {
    expect(readReadings('claude')).toEqual([]);
  });
});
