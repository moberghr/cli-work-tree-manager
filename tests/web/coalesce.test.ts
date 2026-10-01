import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesce } from '../../src/web/src/utils/coalesce.js';

/** A burst of server events (one every 250 ms while any Claude writes) must
 *  cost one refetch, not one each. */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('coalesce', () => {
  it('a burst costs one run per wait, the first a wait after the first trigger — never held back until it settles', async () => {
    const fn = vi.fn(async () => {});
    const c = coalesce(fn, 400);
    c.trigger();
    await vi.advanceTimersByTimeAsync(399);
    c.trigger(); // later triggers don't push it back
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) {
      c.trigger();
      await vi.advanceTimersByTimeAsync(250);
    }
    // 2.5 s of triggers every 250 ms: a run every 400 ms or so, not none until it stops.
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('never runs twice at once, and runs once more for triggers during a run', async () => {
    const runs: Array<ReturnType<typeof deferred>> = [];
    const fn = vi.fn(() => {
      const d = deferred();
      runs.push(d);
      return d.promise;
    });
    const c = coalesce(fn, 100);
    c.trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
    c.trigger(); // events keep coming while the fetch is in flight
    c.trigger();
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);
    runs[0].resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2); // one follow-up, not two
    runs[1].resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a failing run does not stop later ones; cancel stops everything', async () => {
    const fn = vi.fn(async () => {
      throw new Error('server restarting');
    });
    const c = coalesce(fn, 50);
    c.trigger();
    await vi.advanceTimersByTimeAsync(50);
    c.trigger();
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(2);
    c.trigger();
    c.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
