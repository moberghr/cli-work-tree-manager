// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewApp } from '../../src/web/src/apps/ReviewApp.js';
import type { ReviewContext } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom doesn't implement pointer capture; ResizeDivider calls it on drag start.
if (!(Element.prototype as { setPointerCapture?: unknown }).setPointerCapture) {
  (Element.prototype as { setPointerCapture: () => void }).setPointerCapture =
    () => {};
}

const { diff } = vi.hoisted(() => ({
  diff: {
    repos: [
      {
        name: 'repo',
        root: '/tmp/repo',
        files: [
          {
            path: 'a.txt',
            oldPath: 'a.txt',
            newPath: 'a.txt',
            status: 'modified',
            isBinary: false,
            added: 1,
            deleted: 0,
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                context: '',
                lines: [{ kind: 'add', content: 'hi', oldNum: null, newNum: 1 }],
              },
            ],
          },
        ],
      },
    ],
    resolvedBase: 'main',
    headBranch: 'feat/x',
  },
}));

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/api/client.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../src/web/src/api/client.js')>();
  return {
    ...actual,
    fetchScopeDiff: () => Promise.resolve(diff),
    fetchScopeDiffByHash: () => Promise.resolve(diff),
    fetchSessionDiff: () =>
      Promise.resolve({ sessionId: 's1', resolvedBase: 'main', repos: diff.repos }),
    fetchCheckpoints: () => Promise.resolve([]),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderSettled(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The grid reads `var(--sidebar-width)`; the value in effect is the grid's
 *  own inline custom property if set, else the one inherited from an ancestor
 *  (the page wrapper). Mimics CSS cascade for an inline custom property. */
function effectiveSidebarWidth(): string {
  const grid = container.querySelector<HTMLElement>('.wd-web-review-layout');
  const page = container.querySelector<HTMLElement>('.wd-web-review-page');
  if (!grid || !page) throw new Error('layout not rendered');
  return (
    grid.style.getPropertyValue('--sidebar-width') ||
    page.style.getPropertyValue('--sidebar-width')
  );
}

function dispatchPointer(el: Element, type: string, clientX: number) {
  const ev = new MouseEvent(type, { bubbles: true, clientX });
  // React reads pointerId off the event; MouseEvent lacks it but the handler
  // only needs clientX + a defined event, so a plain MouseEvent suffices.
  el.dispatchEvent(ev);
}

describe('ReviewApp sidebar resize wiring', () => {
  const context: ReviewContext = {
    mode: 'review',
    scopeLabel: 'test',
    repos: [],
    readOnly: true,
    initialBase: 'uncommitted',
    staticMode: false,
  };

  it('double-click reset wins even after a drag (ResizeDivider writes to the var-owning element)', async () => {
    await renderSettled(createElement(ReviewApp, { context }));
    const divider = container.querySelector('.wd-resize-divider');
    if (!divider) throw new Error('divider not rendered');

    // Drag the sidebar narrower (clamped to MIN 200).
    act(() => {
      dispatchPointer(divider, 'pointerdown', 300);
      dispatchPointer(divider, 'pointermove', 100);
      dispatchPointer(divider, 'pointerup', 100);
    });
    expect(effectiveSidebarWidth()).toBe('200px');

    // Double-click resets to the default. If ResizeDivider wrote the drag
    // value to a different element than the one React re-renders the
    // committed width onto, a stale inline var shadows the reset.
    await act(async () => {
      divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(effectiveSidebarWidth()).toBe('320px');
  });
});
