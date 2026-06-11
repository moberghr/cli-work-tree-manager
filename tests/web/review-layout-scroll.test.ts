// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewApp } from '../../src/web/src/apps/ReviewApp.js';
import { DiffView } from '../../src/web/src/components/Diff/DiffView.js';
import type {
  ReviewContext,
  SessionSummary,
} from '../../src/web/src/api/client.js';

// React 19 logs a warning unless the test env advertises act support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Shared canned diff — one trivial file is enough to push both components
// past their `repos === null` loading branch into the real layout. Defined
// via vi.hoisted so the (hoisted) vi.mock factories below can reference it.
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
                lines: [
                  { kind: 'add', content: 'hi', oldNum: null, newNum: 1 },
                ],
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

// Stub the network + SSE so the components render without a live server.
// The test only inspects the layout root's class, not behaviour.
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

vi.mock('../../src/web/src/api/review-api.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../src/web/src/api/review-api.js')>();
  const stub = {
    ssePath: '',
    fetch: () => Promise.resolve([]),
    post: () => Promise.resolve({ comments: [] }),
    delete: () => Promise.resolve({ comments: [] }),
    submit: () => Promise.resolve({ comments: [], count: 0 }),
    discard: () => Promise.resolve({ comments: [], discarded: 0 }),
    done: () => Promise.resolve({ ok: true, count: 0 }),
  };
  return {
    ...actual,
    scopeReviewApi: () => stub,
    scopeHashReviewApi: () => stub,
    sessionReviewApi: () => stub,
  };
});

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

// Render + let the (resolved) diff fetch and its effects settle so the
// layout replaces the "Loading diff…" placeholder.
async function renderSettled(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function layout(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.wd-web-review-layout');
  if (!el) throw new Error('review layout not rendered');
  return el;
}

const PAGE = 'wd-web-review-layout--page';

describe('review layout scroll-container scoping', () => {
  // The standalone `wd` page must scroll on the document (not an inner
  // overflow box) so Chrome paints Ctrl+F match ticks on the viewport
  // scrollbar. The body-scroll CSS keys off this modifier class.
  it('ReviewApp (standalone wd page) opts into document scrolling', async () => {
    const context: ReviewContext = {
      mode: 'review',
      scopeLabel: 'test',
      repos: [],
      readOnly: true,
      initialBase: 'uncommitted',
      staticMode: false,
    };
    await renderSettled(createElement(ReviewApp, { context }));

    expect(layout().classList.contains(PAGE)).toBe(true);
    // The scroll override targets the main pane as a direct child — confirm
    // the structure the CSS selector (`.--page > .wd-web-review-main`) relies
    // on is intact.
    expect(
      layout().querySelector(':scope > .wd-web-review-main'),
    ).not.toBeNull();
  });

  // The dashboard's embedded diff sits next to a terminal pane and must keep
  // its bounded inner scroller — it must NOT inherit the page-scroll layout,
  // or one session's diff would grow the whole dashboard.
  it('DiffView (dashboard pane) keeps the bounded inner scroller', async () => {
    const session: SessionSummary = {
      id: 's1',
      target: 'repo',
      branch: 'feat/x',
      isGroup: false,
      paths: ['/tmp/repo'],
      createdAt: '2026-01-01T00:00:00Z',
      lastAccessedAt: '2026-01-01T00:00:00Z',
    };
    await renderSettled(createElement(DiffView, { session }));

    expect(layout().classList.contains(PAGE)).toBe(false);
  });
});
