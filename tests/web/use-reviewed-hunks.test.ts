// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useReviewedHunks } from '../../src/web/src/hooks/use-reviewed-hunks.js';
import { setReviewed } from '../../src/web/src/state/reviewed-hunks.js';

// React 19 logs a warning unless the test env advertises act support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type HookResult = ReturnType<typeof useReviewedHunks>;

/**
 * Minimal hook harness: render a component that calls the hook and stashes
 * its return value so the test can read it between act() flushes. Avoids
 * pulling in @testing-library; jsdom (devDependency) supplies the DOM.
 */
function renderHook(initialScope: string) {
  let latest: HookResult;
  let setScope: (s: string) => void = () => {};
  let container: HTMLDivElement;
  let root: Root;

  function Harness({ scope }: { scope: string }) {
    latest = useReviewedHunks(scope);
    return null;
  }

  function Wrapper() {
    const [scope, setScopeState] = useState(initialScope);
    setScope = setScopeState;
    return createElement(Harness, { scope });
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(Wrapper));
  });

  return {
    get current() {
      return latest;
    },
    setScope(s: string) {
      act(() => setScope(s));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const KEY = 'work-web:reviewed-hunks';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('useReviewedHunks', () => {
  const scope = 'session:abc:repo-a:hunks';

  it('initializes from previously-persisted state for the scope', () => {
    setReviewed(scope, 'f.ts@dead', true);
    const hook = renderHook(scope);
    expect(hook.current.reviewedHunkKeys).toEqual(new Set(['f.ts@dead']));
    hook.unmount();
  });

  it('toggle adds a key, persists it, and updates the live Set', () => {
    const hook = renderHook(scope);
    expect(hook.current.reviewedHunkKeys.size).toBe(0);
    act(() => hook.current.toggle('f.ts@beef', true));
    expect(hook.current.reviewedHunkKeys).toEqual(new Set(['f.ts@beef']));
    // Persisted to localStorage under the reviewed-hunks key.
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      [scope]: { 'f.ts@beef': true },
    });
    hook.unmount();
  });

  it('toggle off removes the key from the Set and storage', () => {
    setReviewed(scope, 'f.ts@beef', true);
    const hook = renderHook(scope);
    act(() => hook.current.toggle('f.ts@beef', false));
    expect(hook.current.reviewedHunkKeys.size).toBe(0);
    expect(localStorage.getItem(KEY) ?? '{}').toBe('{}');
    hook.unmount();
  });

  it('reloads from disk when the scope key changes', () => {
    const other = 'session:abc:repo-b:hunks';
    setReviewed(scope, 'a@1', true);
    setReviewed(other, 'b@2', true);
    const hook = renderHook(scope);
    expect(hook.current.reviewedHunkKeys).toEqual(new Set(['a@1']));
    hook.setScope(other);
    expect(hook.current.reviewedHunkKeys).toEqual(new Set(['b@2']));
    hook.unmount();
  });
});
