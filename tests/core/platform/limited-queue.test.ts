import { describe, expect, it } from 'vitest';
import { createLimitedQueue } from '../../../src/core/platform/throttle.js';

/** At most `max` jobs at a time, the rest in the order they came (a session's own review: its passes run together). */
describe('createLimitedQueue', () => {
  const gate = () => {
    let open: () => void = () => {};
    const wait = new Promise<void>((r) => (open = r));
    return { wait, open };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('runs up to max together, and the next one when a place frees, in the order asked', async () => {
    const run = createLimitedQueue(2);
    const gates = [gate(), gate(), gate(), gate()];
    const started: number[] = [];
    const results = gates.map((g, i) =>
      run(async () => {
        started.push(i);
        await g.wait;
        return i;
      }),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    gates[1].open();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[0].open();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].open();
    gates[3].open();
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
  });

  it('a job that fails, or throws before it has a promise, frees its place and fails alone', async () => {
    const run = createLimitedQueue(1);
    const failed = run(async () => Promise.reject(new Error('no')));
    const threw = run(() => {
      throw new Error('at once');
    });
    const after = run(async () => 'next');
    await expect(failed).rejects.toThrow('no');
    await expect(threw).rejects.toThrow('at once');
    expect(await after).toBe('next');
  });
});
