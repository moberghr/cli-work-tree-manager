import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  previousEnd,
  readWebLife,
  recordExit,
  startWebLife,
  stopOnSignals,
  STOP_SIGNALS,
  type WebLife,
} from '../../../src/core/platform/web-life.js';

// Each test file has its own HOME (tests/setup): ~/.work here is a throwaway.
const life = (over: Partial<WebLife> = {}): WebLife => ({
  pid: 4242,
  version: '2.9.2',
  startedAt: '2026-11-02T12:15:57.000Z',
  lastSeen: '2026-11-02T12:32:00.000Z',
  ...over,
});

describe('how the last work web ended (web-life.ts)', () => {
  it('one that vanished without saying how: stopped from outside, with when it was last seen', () => {
    const said = previousEnd(life(), () => false, 1);
    expect(said).toContain('pid 4242');
    expect(said).toContain('last seen alive at 2026-11-02T12:32:00.000Z');
    expect(said).toContain('stopped from outside');
  });

  it('nothing to say: none before, it ended on its own, it still runs, or it is this one', () => {
    expect(previousEnd(null, () => false, 1)).toBeNull();
    expect(previousEnd(life({ ended: { at: 'x', how: 'exited with code 0' } }), () => false, 1)).toBeNull();
    expect(previousEnd(life(), () => true, 1)).toBeNull();
    expect(previousEnd(life({ pid: 1 }), () => false, 1)).toBeNull();
  });

  it('a running one keeps its record current; its end says how, and the first word wins', () => {
    let t = Date.parse('2026-11-02T12:00:00Z');
    const now = () => new Date(t);
    const rec = startWebLife('2.9.3', now);
    expect(readWebLife()).toMatchObject({ pid: process.pid, version: '2.9.3', startedAt: '2026-11-02T12:00:00.000Z' });
    t += 20_000;
    rec.beat();
    expect(readWebLife()!.lastSeen).toBe('2026-11-02T12:00:20.000Z');
    rec.end('stopped on SIGTERM');
    rec.end('exited with code 0'); // the exit that follows the signal doesn't overwrite it
    rec.beat(); // nor does a late heartbeat
    expect(readWebLife()!.ended).toEqual({ at: '2026-11-02T12:00:20.000Z', how: 'stopped on SIGTERM' });
    // The next one has nothing to add: it said how it ended.
    expect(previousEnd(readWebLife(), () => false, -1)).toBeNull();
  });
});

describe('the wiring: every way out says how (recordExit, stopOnSignals)', () => {
  it('a plain exit is recorded with its code', () => {
    const proc = new EventEmitter();
    recordExit(proc, startWebLife('2.9.3'));
    proc.emit('exit', 3);
    expect(readWebLife()?.ended?.how).toBe('exited with code 3');
  });

  it('a signal stops it saying which; the exit that follows does not overwrite it', () => {
    const proc = new EventEmitter();
    const life = startWebLife('2.9.3');
    recordExit(proc, life);
    stopOnSignals(proc, (how) => life.end(how));
    proc.emit('SIGHUP');
    proc.emit('exit', 0);
    expect(readWebLife()?.ended?.how).toBe('stopped on SIGHUP (its console closed)');
  });

  it('listens to every stop signal, Windows ones included', () => {
    const proc = new EventEmitter();
    const stop = vi.fn();
    stopOnSignals(proc, stop);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) proc.emit(sig);
    expect(stop.mock.calls.map(([how]) => how)).toEqual(Object.values(STOP_SIGNALS));
  });
});
