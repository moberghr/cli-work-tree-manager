/**
 * Call `fn` at most once per `ms`: the first call goes through at once, and
 * calls inside the window collapse into one at its end (so the last state
 * always gets through). For events that make every client refetch.
 */
export function throttleTrailing(
  fn: () => void,
  ms: number,
  clock: { now: () => number; setTimeout: (cb: () => void, ms: number) => unknown } = {
    now: Date.now,
    setTimeout: (cb, t) => setTimeout(cb, t),
  },
): () => void {
  let lastAt = -Infinity;
  let pending = false;
  return () => {
    const wait = lastAt + ms - clock.now();
    if (wait <= 0) {
      lastAt = clock.now();
      fn();
      return;
    }
    if (pending) return;
    pending = true;
    clock.setTimeout(() => {
      pending = false;
      lastAt = clock.now();
      fn();
    }, wait);
  };
}

/**
 * Run jobs one at a time, in the order they came: `run(fn)` resolves with
 * `fn`'s result once every earlier job finished. A failed job doesn't stop
 * the queue.
 */
export function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
