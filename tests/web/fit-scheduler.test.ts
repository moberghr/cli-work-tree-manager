import { describe, expect, it } from 'vitest';
import { FIT_MIN_MS, FitScheduler, type FitTimers } from '../../src/web/src/state/fit-scheduler.js';

/** A clock and timers the test moves by hand. */
function fakeTimers() {
  let now = 1000;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: FitTimers = {
    now: () => now,
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => void pending.delete(id as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance, pending };
}

describe('FitScheduler', () => {
  it('fits a lone request in the next task, never inside the call', () => {
    const t = fakeTimers();
    let fits = 0;
    const s = new FitScheduler(() => fits++, t.timers);
    s.request();
    expect(fits).toBe(0);
    t.advance(0);
    expect(fits).toBe(1);
  });

  it('a burst fits once on its leading edge and once on its trailing edge, at most once per FIT_MIN_MS', () => {
    const t = fakeTimers();
    const at: number[] = [];
    const s = new FitScheduler(() => at.push(t.timers.now()), t.timers);
    s.request();
    t.advance(0);
    for (let i = 0; i < 15; i++) {
      t.advance(3);
      s.request();
    }
    t.advance(FIT_MIN_MS * 4);
    expect(at).toEqual([1000, 1000 + FIT_MIN_MS]);
  });

  it('a drag longer than the interval fits every FIT_MIN_MS while it lasts, and once after it', () => {
    const t = fakeTimers();
    const at: number[] = [];
    const s = new FitScheduler(() => at.push(t.timers.now()), t.timers);
    for (let i = 0; i < 40; i++) {
      s.request();
      t.advance(4); // a frame-ish every 4 ms for 160 ms
    }
    t.advance(FIT_MIN_MS * 4);
    expect(at).toEqual([1000, 1050, 1100, 1150, 1200]);
  });

  it('a request long after the last fit runs at once again', () => {
    const t = fakeTimers();
    const at: number[] = [];
    const s = new FitScheduler(() => at.push(t.timers.now()), t.timers);
    s.request();
    t.advance(500);
    s.request();
    t.advance(0);
    expect(at).toEqual([1000, 1500]);
  });

  it('dispose drops a pending fit', () => {
    const t = fakeTimers();
    let fits = 0;
    const s = new FitScheduler(() => fits++, t.timers);
    s.request();
    s.dispose();
    t.advance(1000);
    expect(fits).toBe(0);
    expect(t.pending.size).toBe(0);
  });

  it('justifies its interval: 50 ms, between Tabby (32) and Codex (75), as Theia', () => {
    expect(FIT_MIN_MS).toBe(50);
  });
});
