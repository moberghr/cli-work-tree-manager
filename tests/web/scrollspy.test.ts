// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useScrollspy } from '../../src/web/src/hooks/use-scrollspy.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The diff's files change under the same key (live "Show", base toggle,
 *  Last turn); the spy must follow the files that are there now. */

let container: HTMLDivElement;
let root: Root;
let seen: Array<string | null>;
const tops = new Map<string, number>();

function Spy({ files }: { files: string[] }) {
  seen.push(useScrollspy('session-1:repo'));
  return createElement(
    'main',
    { className: 'wd-web-review-main' },
    files.map((id) => createElement('article', { key: id, id, className: 'wd-file' })),
  );
}

beforeEach(() => {
  seen = [];
  tops.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => {
    cb();
    return 0;
  };
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: tops.get(this.id) ?? 1000 } as DOMRect;
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('useScrollspy', () => {
  it('starts following files that appear after an empty diff', async () => {
    await act(async () => root.render(createElement(Spy, { files: [] })));
    expect(seen.at(-1)).toBeNull();
    // Claude writes files; "Show" lands them under the same key.
    await act(async () => root.render(createElement(Spy, { files: ['f1', 'f2'] })));
    await flush();
    expect(seen.at(-1)).toBe('f1');
    tops.set('f1', -500).set('f2', 40);
    window.dispatchEvent(new Event('scroll'));
    await flush();
    expect(seen.at(-1)).toBe('f2');
  });

  it('never picks a file that the update removed', async () => {
    await act(async () => root.render(createElement(Spy, { files: ['a', 'b', 'c'] })));
    tops.set('a', -900).set('b', -500).set('c', 40);
    window.dispatchEvent(new Event('scroll'));
    await flush();
    expect(seen.at(-1)).toBe('c');
    await act(async () => root.render(createElement(Spy, { files: ['a', 'b'] }))); // c is gone now
    await flush();
    expect(seen.at(-1)).toBe('b');
  });
});
