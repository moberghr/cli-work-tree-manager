import { describe, expect, it } from 'vitest';
import { sleepCandidates } from '../../src/core/idle-sleep.js';
import type { PtyInfo } from '../../src/core/pty-host-protocol.js';

const NOW = Date.parse('2026-09-30T18:00:00Z');
const HOUR = 3_600_000;
const pty = (id: string, over: Partial<PtyInfo> = {}): PtyInfo => ({
  id, cwd: `/wt/${id}`, pid: 1, exited: false, cols: 80, rows: 24, startedAt: '', restored: false,
  clients: 0, lastOutputAt: new Date(NOW - 5 * HOUR).toISOString(), ...over,
});
const idle = () => false;

describe('sleepCandidates', () => {
  it('puts to sleep a Claude quiet for long enough with nothing attached', () => {
    expect(sleepCandidates([pty('a')], NOW, 4 * HOUR, idle)).toEqual(['a']);
  });

  it('keeps one that is attached, recently printed, busy, or the assistant', () => {
    const ptys = [
      pty('watched', { clients: 1 }),
      pty('recent', { lastOutputAt: new Date(NOW - HOUR).toISOString() }),
      pty('busy'),
      pty('assistant'),
      pty('gone', { exited: true }),
    ];
    expect(sleepCandidates(ptys, NOW, 4 * HOUR, (id) => id === 'busy')).toEqual([]);
  });

  it('never acts on a host that does not report clients, or when switched off', () => {
    expect(sleepCandidates([pty('old-host', { clients: undefined })], NOW, 4 * HOUR, idle)).toEqual([]);
    expect(sleepCandidates([pty('a')], NOW, 0, idle)).toEqual([]);
  });
});
