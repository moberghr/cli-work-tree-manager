// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDeferredDiffLoad } from '../../src/web/src/hooks/use-deferred-diff-load.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Load = ReturnType<typeof useDeferredDiffLoad<unknown>>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderHook(
  fetcher: () => Promise<unknown>,
  deps: unknown[],
  delayMs: number,
) {
  let latest: Load = { data: null, error: null, loading: false };
  function Harness() {
    latest = useDeferredDiffLoad(fetcher, deps, delayMs);
    return null;
  }
  act(() => {
    root.render(createElement(Harness));
  });
  return {
    get current() {
      return latest;
    },
  };
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('useDeferredDiffLoad', () => {
  it('does NOT strand loading=true when a fast fetch settles before the delay (regression)', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((r) => {
        resolveFn = r;
      });
    const h = renderHook(fetcher, [1], 50);

    // Resolve immediately — faster than the 50ms show-delay.
    resolveFn({ ok: 1 });
    await flush();
    expect(h.current.data).toEqual({ ok: 1 });
    expect(h.current.loading).toBe(false);

    // The show-timer must have been cancelled on settle. With the bug it
    // fires here and pins loading=true with no effect run left to clear it.
    await wait(90);
    expect(h.current.loading).toBe(false);
  });

  it('shows loading after the delay for a slow fetch, then clears on resolve', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((r) => {
        resolveFn = r;
      });
    const h = renderHook(fetcher, [1], 50);

    expect(h.current.loading).toBe(false); // before the delay elapses
    await wait(90);
    expect(h.current.loading).toBe(true); // delay elapsed, still in flight

    resolveFn({ ok: 2 });
    await flush();
    expect(h.current.loading).toBe(false);
    expect(h.current.data).toEqual({ ok: 2 });
  });

  it('captures the error message and clears loading on rejection', async () => {
    let rejectFn: (e: Error) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((_, rej) => {
        rejectFn = rej;
      });
    const h = renderHook(fetcher, [1], 50);

    rejectFn(new Error('boom'));
    await flush();
    expect(h.current.error).toBe('boom');
    expect(h.current.loading).toBe(false);
    expect(h.current.data).toBeNull();
  });
});
