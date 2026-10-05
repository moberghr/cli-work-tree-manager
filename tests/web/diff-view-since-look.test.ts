// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every diff fetch is recorded (with its range) and answered with one
// file named after the request, so the test can see which scope loaded.
const h = vi.hoisted(() => {
  const calls: Array<{ sessionId: string; base: string; range?: { from: number; to: number | 'working' } }> = [];
  let seen: { checkpointId: number; at: string } | null = null;
  const marked: Array<{ sessionId: string; checkpointId: number }> = [];
  let checkpoints: Array<{ id: number; ts: string; label?: string; repos: Record<string, string | null> }> = [];
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
  return {
    calls,
    diffFor,
    marked,
    get seen() {
      return seen;
    },
    set seen(v) {
      seen = v;
    },
    get checkpoints() {
      return checkpoints;
    },
    set checkpoints(v) {
      checkpoints = v;
    },
  };
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
  const actual = await importActual<typeof import('../../src/web/src/api/client.js')>();
  return {
    ...actual,
    fetchDiffSeen: () => Promise.resolve(h.seen),
    markDiffSeen: (sessionId: string, checkpointId: number) => {
      h.marked.push({ sessionId, checkpointId });
      return Promise.resolve();
    },
    fetchSessionDiff: (sessionId: string, base: string, range?: { from: number; to: number | 'working' }) => {
      h.calls.push({ sessionId, base, range });
      const file = range ? `turn-${range.from}-${range.to}.txt` : `${base}.txt`;
      return Promise.resolve(h.diffFor(sessionId, file));
    },
    fetchSessionCheckpoints: () => Promise.resolve(h.checkpoints),
    fetchCheckpoints: () => Promise.resolve([]),
  };
});

import { DiffView } from '../../src/web/src/components/Diff/DiffView.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  h.calls.length = 0;
  h.checkpoints = [];
  h.marked.length = 0;
  h.seen = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session = (id: string): SessionSummary => ({
  id,
  target: 'repo',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/tmp/repo'],
  createdAt: '2026-09-01T00:00:00Z',
  lastAccessedAt: '2026-09-01T00:00:00Z',
});
const entry = (id: number, label?: string) => ({ id, ts: `2026-09-01T00:0${id}:00Z`, label, repos: { repo: null } });
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const tab = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === name)!;

async function render(id = 's1', startOnLastTurn = false) {
  await act(async () => {
    root.render(createElement(DiffView, { session: session(id), startOnLastTurn }));
  });
  await flush();
}

describe('DiffView "Since you looked"', () => {
  it('Claude finished turns after you last looked: it opens on everything since, up to the working tree', async () => {
    h.checkpoints = [entry(0, 'Initial'), entry(1, 'Wrote it'), entry(2, 'Fixed review'), entry(3, 'Your comments')];
    h.seen = { checkpointId: 1, at: '2026-09-01T00:01:00Z' };
    await render();
    expect(tab('Since you looked').getAttribute('aria-selected')).toBe('true');
    expect(h.calls.at(-1)?.range).toEqual({ from: 1, to: 'working' });
    expect(container.textContent).toContain('turn-1-working.txt');
    // The other scopes are still a click away.
    await act(async () => tab('Since branch').click());
    await flush();
    expect(h.calls.at(-1)).toMatchObject({ base: 'branch', range: undefined });
    expect(tab('Since you looked').getAttribute('aria-selected')).toBe('false');
  });

  it('nothing new since you looked, or never looked: no such scope, the usual default', async () => {
    h.checkpoints = [entry(0, 'Initial'), entry(1, 'Wrote it')];
    h.seen = { checkpointId: 1, at: '2026-09-01T00:01:00Z' };
    await render();
    expect(tab('Since you looked')).toBeUndefined();
    expect(container.textContent).toContain('uncommitted.txt');
    act(() => root.unmount());
    root = createRoot(container);
    h.seen = null;
    await render('s2');
    expect(tab('Since you looked')).toBeUndefined();
  });

  it('asked to open on the last turn (the review queue): that wins', async () => {
    h.checkpoints = [entry(0, 'Initial'), entry(1, 'Wrote it'), entry(2, 'Fixed review')];
    h.seen = { checkpointId: 0, at: '2026-09-01T00:00:00Z' };
    await render('s1', true);
    expect(tab('Last turn').getAttribute('aria-selected')).toBe('true');
    expect(tab('Since you looked').getAttribute('aria-selected')).toBe('false');
  });

  it('looked at for five seconds (visible, focused): that far is seen; a glance or a hidden window is not', async () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      h.checkpoints = [entry(0, 'Initial'), entry(1, 'Wrote it'), entry(2, 'Fixed review')];
      await act(async () => {
        root.render(createElement(DiffView, { session: session('s1') }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      focus.mockReturnValue(false); // another app in front: doesn't count
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(h.marked).toEqual([]);
      focus.mockReturnValue(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(h.marked).toEqual([{ sessionId: 's1', checkpointId: 2 }]);
    } finally {
      focus.mockRestore();
      vi.useRealTimers();
    }
  });
});
