// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every diff fetch is recorded (with its range) and answered with one
// file named after the request, so the test can see which scope loaded.
const h = vi.hoisted(() => {
  const calls: Array<{ sessionId: string; base: string; range?: { from: number; to: number } }> = [];
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
    fetchSessionDiff: (sessionId: string, base: string, range?: { from: number; to: number }) => {
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

describe('DiffView "Last turn"', () => {
  it('is disabled until a turn has finished', async () => {
    h.checkpoints = [entry(0, 'Initial')];
    await render();
    expect(tab('Last turn').disabled).toBe(true);
    expect(tab('Last turn').title).toMatch(/No finished turn/);
  });

  it("shows only the newest turn's range, and earlier turns from the picker", async () => {
    h.checkpoints = [entry(0, 'Initial'), entry(1, 'Wrote it'), entry(2, 'Fixed review')];
    await render();
    expect(container.textContent).toContain('uncommitted.txt');

    await act(async () => tab('Last turn').click());
    await flush();
    expect(h.calls.at(-1)?.range).toEqual({ from: 1, to: 2 });
    expect(container.textContent).toContain('turn-1-2.txt');
    expect(tab('Last turn').getAttribute('aria-selected')).toBe('true');
    expect(tab('Uncommitted').getAttribute('aria-selected')).toBe('false');

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Which turn"]')!;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['2 · Fixed review', '1 · Wrote it']);
    await act(async () => {
      picker.value = '1';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(h.calls.at(-1)?.range).toEqual({ from: 0, to: 1 });
    expect(container.textContent).toContain('turn-0-1.txt');

    // Back to a plain scope drops the range.
    await act(async () => tab('Since branch').click());
    await flush();
    expect(h.calls.at(-1)).toMatchObject({ base: 'branch', range: undefined });
    expect(container.querySelector('select[aria-label="Which turn"]')).toBeNull();
  });

  it('opened to review finished work, it starts on the last turn — once, then the buttons are yours', async () => {
    h.checkpoints = [entry(0), entry(1), entry(2)];
    await render('s1', true);
    await flush();
    expect(h.calls.at(-1)?.range).toEqual({ from: 1, to: 2 });
    expect(tab('Last turn').getAttribute('aria-selected')).toBe('true');
    await act(async () => tab('Uncommitted').click());
    await flush();
    await render('s1', true); // a re-render (SSE refresh) doesn't pull you back
    expect(tab('Uncommitted').getAttribute('aria-selected')).toBe('true');
    // No finished turn yet: stays on Uncommitted.
    h.checkpoints = [entry(0)];
    await render('s2', true);
    expect(h.calls.at(-1)).toMatchObject({ sessionId: 's2', range: undefined });
  });

  it('switching sessions leaves turn mode', async () => {
    h.checkpoints = [entry(0), entry(1)];
    await render('s1');
    await act(async () => tab('Last turn').click());
    await flush();
    expect(h.calls.at(-1)?.range).toEqual({ from: 0, to: 1 });
    await render('s2');
    expect(h.calls.at(-1)).toMatchObject({ sessionId: 's2', range: undefined });
  });
});
