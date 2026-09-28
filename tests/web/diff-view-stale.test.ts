// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// A session diff whose fetch the test resolves by hand, so the second
// session's load can be held "in flight" while we inspect the DOM.
const h = vi.hoisted(() => {
  const pending = new Map<string, (v: unknown) => void>();
  const diffFor = (sessionId: string, file: string) => ({
    sessionId,
    base: 'uncommitted',
    resolvedBase: 'main',
    repos: [
      {
        name: 'repo',
        root: '/tmp/repo',
        files: [
          {
            path: file,
            oldPath: file,
            newPath: file,
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
                lines: [{ kind: 'add', content: `in ${sessionId}`, oldNum: null, newNum: 1 }],
              },
            ],
          },
        ],
      },
    ],
  });
  return { pending, diffFor };
});

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
  const actual =
    await importActual<typeof import('../../src/web/src/api/client.js')>();
  return {
    ...actual,
    fetchSessionDiff: (sessionId: string) =>
      new Promise((resolve) => h.pending.set(sessionId, resolve)),
    fetchCheckpoints: () => Promise.resolve([]),
  };
});

import { DiffView } from '../../src/web/src/components/Diff/DiffView.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  h.pending.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session = (id: string, branch: string): SessionSummary => ({
  id,
  target: 'repo',
  branch,
  isGroup: false,
  paths: ['/tmp/repo'],
  createdAt: '2026-09-01T00:00:00Z',
  lastAccessedAt: '2026-09-01T00:00:00Z',
});

async function resolveDiff(sessionId: string, file: string) {
  await act(async () => {
    h.pending.get(sessionId)!(h.diffFor(sessionId, file));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const main = () => container.querySelector<HTMLElement>('.wd-web-review-main')!;
const tree = () => container.querySelector<HTMLElement>('.wd-sidebar-split-top')!;
const headerText = () =>
  container.querySelector('.wd-web-review-sidebar-header')!.textContent ?? '';

describe('DiffView while switching sessions', () => {
  it("marks the previous session's diff stale until the selected one loads", async () => {
    await act(async () => {
      root.render(createElement(DiffView, { session: session('s1', 'feat/one') }));
    });
    await resolveDiff('s1', 'one.txt');

    expect(main().classList.contains('wd-diff-stale')).toBe(false);
    expect(main().hasAttribute('inert')).toBe(false);
    expect(headerText()).toContain('1 file changed');

    // Switch sessions: s2's fetch stays pending.
    await act(async () => {
      root.render(createElement(DiffView, { session: session('s2', 'feat/two') }));
    });

    // Header already names the new session...
    expect(headerText()).toContain('feat/two');
    // ...while the body still shows s1's diff, so it must be marked.
    expect(container.textContent).toContain('one.txt');
    expect(main().classList.contains('wd-diff-stale')).toBe(true);
    expect(main().hasAttribute('inert')).toBe(true);
    expect(main().getAttribute('aria-busy')).toBe('true');
    expect(tree().classList.contains('wd-diff-stale')).toBe(true);
    expect(tree().hasAttribute('inert')).toBe(true);
    expect(headerText()).toContain('loading…');
    expect(headerText()).not.toContain('1 file changed');

    await resolveDiff('s2', 'two.txt');

    expect(container.textContent).toContain('two.txt');
    expect(main().classList.contains('wd-diff-stale')).toBe(false);
    expect(main().hasAttribute('inert')).toBe(false);
    expect(main().getAttribute('aria-busy')).toBe('false');
    expect(tree().classList.contains('wd-diff-stale')).toBe(false);
    expect(headerText()).toContain('1 file changed');
  });

  it('shows the plain loading state (not a stale diff) on first load', async () => {
    await act(async () => {
      root.render(createElement(DiffView, { session: session('s1', 'feat/one') }));
    });
    expect(container.textContent).toContain('Loading diff…');
    expect(container.querySelector('.wd-diff-stale')).toBeNull();
  });
});
