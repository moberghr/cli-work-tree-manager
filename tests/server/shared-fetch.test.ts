import { describe, expect, it, vi } from 'vitest';
import { createSharedFetch } from '../../src/server/shared-fetch.js';

describe('createSharedFetch', () => {
  it('one fetch for concurrent callers, reused until it is stale', async () => {
    let t = 0;
    let n = 0;
    const fetch = vi.fn(async () => ++n);
    const f = createSharedFetch(fetch, 1000, () => t);
    expect(await Promise.all([f.get(), f.get(), f.get()])).toEqual([1, 1, 1]);
    t = 999;
    expect(await f.get()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('when stale, serves the last result at once and refreshes in the background', async () => {
    let t = 0;
    let n = 0;
    let release!: () => void;
    const fetch = vi.fn(() => (n === 0 ? Promise.resolve(++n) : new Promise<number>((r) => (release = () => r(++n)))));
    const f = createSharedFetch(fetch, 1000, () => t);
    await f.get();
    t = 1000;
    expect(await f.get()).toBe(1); // didn't wait for the refresh
    expect(await f.get()).toBe(1); // …and didn't start a second one
    expect(fetch).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(async () => expect(await f.get()).toBe(2));
  });

  it('a failed refresh keeps the last good result; with none, the caller sees the error', async () => {
    let t = 0;
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('rate limit');
      return 'prs';
    });
    const f = createSharedFetch(fetch, 1000, () => t);
    await f.get();
    fail = true;
    t = 5000;
    expect(await f.get()).toBe('prs');
    await new Promise((r) => setTimeout(r, 0));
    expect(await f.get()).toBe('prs');
    f.invalidate();
    await expect(f.get()).rejects.toThrow('rate limit');
  });
});
