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
  let latest: Load = {
    data: null,
    error: null,
    loading: false,
    checking: false,
    pending: null,
    applyPending: () => {},
    reload: () => {},
    checkForUpdates: () => {},
  };
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

describe('useDeferredDiffLoad staged live updates', () => {
  it('stages a differing background result instead of applying it', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((r) => {
        resolveFn = r;
      });
    const h = renderHook(fetcher, [1], 50);

    resolveFn({ files: 1 });
    await flush();
    expect(h.current.data).toEqual({ files: 1 });

    // A file-watch event arrives: fetch quietly, don't touch `data`.
    act(() => h.current.checkForUpdates());
    // Deferred like `loading` — a fast check must not flicker the chip.
    expect(h.current.checking).toBe(false);
    await wait(90);
    expect(h.current.checking).toBe(true); // slow check, still in flight
    resolveFn({ files: 2 });
    await flush();
    expect(h.current.checking).toBe(false);
    expect(h.current.data).toEqual({ files: 1 }); // view held still
    expect(h.current.pending).toEqual({ files: 2 });
    expect(h.current.loading).toBe(false); // background never dims the diff

    // Only the user's click swaps it in.
    act(() => h.current.applyPending());
    expect(h.current.data).toEqual({ files: 2 });
    expect(h.current.pending).toBeNull();
  });

  it('does not stage a background result identical to the shown diff', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((r) => {
        resolveFn = r;
      });
    const h = renderHook(fetcher, [1], 50);
    resolveFn({ files: 1 });
    await flush();

    act(() => h.current.checkForUpdates());
    resolveFn({ files: 1 }); // same content, new object
    await flush();
    expect(h.current.pending).toBeNull();
    // A check that settled before the delay must leave no stranded chip.
    await wait(90);
    expect(h.current.checking).toBe(false);
  });

  it('clears a stale staged payload when a shown update makes it moot', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((r) => {
        resolveFn = r;
      });
    const h = renderHook(fetcher, [1], 50);
    resolveFn({ files: 1 });
    await flush();

    act(() => h.current.checkForUpdates());
    resolveFn({ files: 2 });
    await flush();
    expect(h.current.pending).toEqual({ files: 2 });

    // The file is reverted: the next check matches what's on screen once
    // applied, so the banner must go away rather than linger.
    act(() => h.current.applyPending());
    act(() => h.current.checkForUpdates());
    resolveFn({ files: 2 });
    await flush();
    expect(h.current.pending).toBeNull();
  });

  it('applies a background result directly when nothing is shown yet', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((r) => {
        resolveFn = r;
      });
    const h = renderHook(fetcher, [1], 50);

    // Initial fetch still in flight — there's no reading position to protect.
    act(() => h.current.checkForUpdates());
    resolveFn({ files: 3 });
    await flush();
    expect(h.current.data).toEqual({ files: 3 });
    expect(h.current.pending).toBeNull();
  });

  it('reload() refetches in the foreground and drops the staged payload', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetcher = () =>
      new Promise<unknown>((r) => {
        resolveFn = r;
      });
    const h = renderHook(fetcher, [1], 50);
    resolveFn({ files: 1 });
    await flush();

    act(() => h.current.checkForUpdates());
    resolveFn({ files: 2 });
    await flush();
    expect(h.current.pending).toEqual({ files: 2 });

    // "Reload" goes back to the server rather than applying the staged copy,
    // and the staged copy must not survive the run.
    act(() => h.current.reload());
    expect(h.current.pending).toBeNull();
    resolveFn({ files: 3 });
    await flush();
    expect(h.current.data).toEqual({ files: 3 });
    expect(h.current.pending).toBeNull();
  });
});
