// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Diff tab's "Open in browser" and full screen.
const h = vi.hoisted(() => ({
  pageFor: vi.fn(async (id: string) => `/diff/hash-of-${id}`),
  lines: vi.fn(async (_hash?: string, _repo?: string, _path?: string, start = 1, end = 1) => ({
    lines: Array.from({ length: end - start + 1 }, (_, i) => `line ${start + i}`),
    start,
    totalLines: 100,
    eof: false,
  })),
  repos: [] as unknown[],
}));

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/api/review-api.js', () => ({
  sessionReviewApi: () => ({
    fetch: () => Promise.resolve([]),
    post: () => Promise.resolve({ comments: [] }),
    delete: () => Promise.resolve({ comments: [] }),
    resolve: () => Promise.resolve({ comments: [] }),
    submit: () => Promise.resolve({ comments: [], count: 0 }),
    discard: () => Promise.resolve({ comments: [], discarded: 0 }),
    done: () => Promise.resolve(),
    ssePath: '/events',
  }),
}));
vi.mock('../../src/web/src/api/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/web/src/api/client.js')>();
  return {
    ...actual,
    fetchSessionDiff: (sessionId: string) => Promise.resolve({ sessionId, base: 'uncommitted', resolvedBase: 'main', repos: h.repos }),
    fetchFileLines: (...a: Parameters<typeof h.lines>) => h.lines(...a),
    fetchCheckpoints: () => Promise.resolve([]),
    fetchSessionHistory: () => Promise.resolve({ entries: [], commits: [] }),
    fetchDiffSeen: () => Promise.resolve(null),
    sessionDiffPage: (id: string) => h.pageFor(id),
  };
});

import { DiffView } from '../../src/web/src/components/Diff/DiffView.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  h.pageFor.mockClear();
  h.lines.mockClear();
  h.repos = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  target: 'repo',
  branch: 'feat/one',
  isGroup: false,
  paths: ['/tmp/repo'],
  createdAt: '2026-09-01T00:00:00Z',
  lastAccessedAt: '2026-09-01T00:00:00Z',
  ...over,
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("the Diff tab's own page and full screen", () => {
  it('Open in browser: the page wd opens for this diff, set up when the tab opens, opened outside the app', async () => {
    act(() => root.render(createElement(DiffView, { session: session() })));
    await flush();
    expect(h.pageFor).toHaveBeenCalledWith('s1');
    const link = container.querySelector<HTMLAnchorElement>('.wd-diff-open-page')!;
    expect(link.getAttribute('href')).toBe('/diff/hash-of-s1');
    expect(link.target).toBe('_blank'); // the desktop app sends a new window to your browser
  });

  it("an archived session has no page (nothing asked); without a place for it, there's no Full screen", async () => {
    act(() => root.render(createElement(DiffView, { session: session({ archivedAt: '2026-10-01T00:00:00Z' }) })));
    await flush();
    expect(h.pageFor).not.toHaveBeenCalled();
    expect(container.querySelector('.wd-diff-open-page')).toBeNull();
    expect(container.querySelector('.wd-diff-fullscreen')).toBeNull();
  });

  it('Full screen fills the window; Esc (or the button) leaves', async () => {
    const onFullScreen = vi.fn();
    act(() => root.render(createElement(DiffView, { session: session(), onFullScreen })));
    await flush();
    const btn = () => container.querySelector<HTMLButtonElement>('.wd-diff-fullscreen')!;
    expect(btn().textContent).toBe('Full screen');
    act(() => btn().click());
    expect(onFullScreen).toHaveBeenLastCalledWith(true);
    act(() => root.render(createElement(DiffView, { session: session(), onFullScreen, fullScreen: true })));
    expect(btn().textContent).toBe('Exit full screen');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onFullScreen).toHaveBeenLastCalledWith(false);
  });

  it('Esc that closes the Changes picker (or anything else open) is theirs: full screen stays', async () => {
    const onFullScreen = vi.fn();
    act(() => root.render(createElement(DiffView, { session: session(), onFullScreen, fullScreen: true })));
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
    const esc = () =>
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
    esc();
    expect(onFullScreen).not.toHaveBeenCalled();
    // A menu open somewhere (a row's menu, a dialog): its Esc too.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    esc();
    expect(onFullScreen).not.toHaveBeenCalled();
    menu.remove();
    esc();
    expect(onFullScreen).toHaveBeenLastCalledWith(false);
  });

  it("the arrows between hunks, as on wd's own page: lines read through the session's scope, from the working tree here", async () => {
    h.repos = [
      {
        name: 'repo',
        root: '/tmp/repo',
        files: [
          {
            path: 'src/a.ts',
            oldPath: 'src/a.ts',
            newPath: 'src/a.ts',
            status: 'modified',
            isBinary: false,
            added: 1,
            deleted: 0,
            hunks: [
              {
                oldStart: 20,
                oldLines: 1,
                newStart: 20,
                newLines: 2,
                context: '',
                lines: [
                  { kind: 'context', content: 'kept', oldNum: 20, newNum: 20 },
                  { kind: 'add', content: 'new', oldNum: null, newNum: 21 },
                ],
              },
            ],
          },
        ],
      },
    ];
    act(() => root.render(createElement(DiffView, { session: session() })));
    await flush();
    await flush();
    const arrow = container.querySelector<HTMLButtonElement>('.wd-expander-btn');
    expect(arrow).not.toBeNull();
    await act(async () => {
      arrow!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.lines).toHaveBeenCalledWith('hash-of-s1', 'repo', 'src/a.ts', expect.any(Number), expect.any(Number), undefined);
    expect(container.textContent).toContain('line 1');
  });
});
