// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { pointParam, type DiffPoint } from '../../src/core/diff/diff-points.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Revert calls are recorded too; every diff fetch is recorded (with its range) and answered with one
// file named after the request, so the test can see which scope loaded.
const h = vi.hoisted(() => {
  const calls: Array<{ sessionId: string; base: string; range?: { from: string; to: string } }> = [];
  const reverts: Array<{ sessionId: string; req: unknown }> = [];
  let revertError: string | null = null;
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
    reverts,
    get revertError() {
      return revertError;
    },
    set revertError(v) {
      revertError = v;
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
    fetchSessionDiff: (sessionId: string, base: string, range?: { from: DiffPoint; to: DiffPoint }) => {
      const r = range && { from: pointParam(range.from), to: pointParam(range.to) };
      h.calls.push({ sessionId, base, range: r });
      const file = r ? `${r.from}..${r.to}.txt` : `${base}.txt`;
      return Promise.resolve(h.diffFor(sessionId, file));
    },
    fetchSessionHistory: () => Promise.resolve({ entries: h.checkpoints, commits: [] }),
    revertChange: (sessionId: string, req: unknown) => {
      h.reverts.push({ sessionId, req });
      return h.revertError ? Promise.reject(new Error(h.revertError)) : Promise.resolve({ ok: true, description: 'x' });
    },
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
  h.reverts.length = 0;
  h.revertError = null;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
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

async function render(id = 's1') {
  await act(async () => {
    root.render(createElement(DiffView, { session: session(id) }));
  });
  await flush();
}

const button = (label: RegExp) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.getAttribute('aria-label') ?? ''));

describe('DiffView revert', () => {
  it('offers file and hunk revert on the Uncommitted diff, and reloads after', async () => {
    await render();
    const hunk = button(/^Revert hunk: uncommitted.txt lines 1–1$/)!;
    expect(button(/^Revert file: uncommitted.txt$/)).toBeTruthy();
    const before = h.calls.length;
    await act(async () => hunk.click());
    await flush();
    expect(h.reverts).toEqual([{ sessionId: 's1', req: { repo: 'repo', path: 'uncommitted.txt', lines: { start: 1, end: 1 } } }]);
    expect(h.calls.length).toBeGreaterThan(before);

    await act(async () => button(/^Revert file/)!.click());
    await flush();
    expect(h.reverts.at(-1)?.req).toEqual({ repo: 'repo', path: 'uncommitted.txt', lines: undefined });
  });

  it('does nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await render();
    await act(async () => button(/^Revert file/)!.click());
    expect(h.reverts).toEqual([]);
  });

  it("shows the server's reason when it refuses", async () => {
    h.revertError = 'the file changed since — reload the diff';
    await render();
    await act(async () => button(/^Revert file/)!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('the file changed since — reload the diff');
  });

  it('is not offered on the branch diff or a turn', async () => {
    h.checkpoints = [entry(0), entry(1)];
    await render();
    await act(async () => tab('Since branch').click());
    await flush();
    expect(button(/^Revert/)).toBeUndefined();
    // A turn, from the picker's shortcut.
    await act(async () => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
    const lastTurn = [...container.querySelectorAll<HTMLButtonElement>('.wd-checkpoint-pop-preset')].find(
      (b) => b.textContent === 'Last turn',
    )!;
    await act(async () => lastTurn.click());
    await flush();
    expect(h.calls.at(-1)?.range).toEqual({ from: 'cp:0', to: 'cp:1' });
    expect(button(/^Revert/)).toBeUndefined();
  });
});
