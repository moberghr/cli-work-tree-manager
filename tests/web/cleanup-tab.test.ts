// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CleanupCandidate, CleanupState } from '../../src/web/src/api/client.js';
import { CleanupTab, type CleanupApi } from '../../src/web/src/components/Dashboard/tabs/CleanupTab.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const cand = (id: string, verdict: CleanupCandidate['verdict'], suggested: CleanupCandidate['suggested'], over: Partial<CleanupCandidate> = {}): CleanupCandidate => ({
  sessionId: id, target: 'api', branch: `feat/${id}`, isGroup: false, lastActive: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  archivedAt: null, verdict, suggested, reason: `reason ${id}`, repos: [], ...over,
});
const DONE: CleanupState = {
  phase: 'idle', done: 4, total: 4, results: [], finishedAt: new Date().toISOString(),
  candidates: [
    cand('merged', 'merged', 'delete'),
    cand('gone', 'gone', 'forget'),
    cand('dirty', 'dirty', 'archive'),
    cand('recentwork', 'work', null),
  ],
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Visible text with a space between elements (textContent glues them). */
const text = (el: Element | null): string => {
  if (!el) return '';
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) parts.push(n.textContent ?? '');
    else for (const c of n.childNodes) { walk(c); if ((c as Element).tagName) parts.push(' '); }
  };
  walk(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
};
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const checkbox = (id: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Select api feat/${id}"]`)!;

function fakeApi(first: CleanupState) {
  const applied: unknown[] = [];
  return {
    applied,
    state: vi.fn(async (): Promise<CleanupState> => first),
    scan: vi.fn(async (): Promise<CleanupState> => first),
    apply: vi.fn(async (items: unknown): Promise<CleanupState> => { applied.push(items); return { ...first, results: [] }; }),
  } satisfies CleanupApi & { applied: unknown[] };
}

describe('CleanupTab', () => {
  it('scans on the first visit, and shows progress while the job runs', async () => {
    const api = fakeApi({ phase: 'idle', done: 0, total: 0, candidates: [], results: [] });
    api.scan.mockResolvedValueOnce({ phase: 'scanning', done: 12, total: 40, candidates: [], results: [] });
    act(() => root.render(createElement(CleanupTab, { onOpenSession: vi.fn(), api, pollMs: 10_000 })));
    await flush();
    expect(api.scan).toHaveBeenCalledTimes(1);
    expect(text(container.querySelector('[role=status]'))).toBe('Checking 12 of 40 worktrees…');
  });

  it('pre-selects the suggestions, splits safe from work of its own, and never offers delete for work', async () => {
    const api = fakeApi(DONE);
    act(() => root.render(createElement(CleanupTab, { onOpenSession: vi.fn(), api })));
    await flush();
    expect(api.scan).not.toHaveBeenCalled(); // a result exists already
    const titles = [...container.querySelectorAll('.wd-cleanup-section h2')].map((h) => text(h).replace(/ Select all None$/, ''));
    expect(titles).toEqual(['Safe to remove (2)', 'Has work of its own (2)']);
    expect([checkbox('merged').checked, checkbox('gone').checked, checkbox('dirty').checked, checkbox('recentwork').checked]).toEqual([true, true, true, false]);
    const workOptions = [...container.querySelectorAll('.wd-cleanup-work select option, .wd-cleanup-work .wd-cleanup-action')].map((o) => o.textContent);
    expect(workOptions).not.toContain('Remove worktree');
    expect(text(container.querySelector('.wd-cleanup-bar'))).toContain('3 selected: remove 1 · archive 1 · forget 1');
  });

  it('applies only after a second click, sending exactly the chosen actions', async () => {
    const api = fakeApi(DONE);
    act(() => root.render(createElement(CleanupTab, { onOpenSession: vi.fn(), api })));
    await flush();
    act(() => checkbox('gone').click()); // untick one
    await act(async () => button('Apply').click());
    expect(api.apply).not.toHaveBeenCalled();
    const confirm = button('Confirm: remove 1 · archive 1');
    expect(confirm).toBeDefined();
    await act(async () => confirm.click());
    await flush();
    expect(api.applied).toEqual([[{ sessionId: 'merged', action: 'delete' }, { sessionId: 'dirty', action: 'archive' }]]);
  });

  it('lists what was left alone, with the reason', async () => {
    const api = fakeApi({ ...DONE, results: [{ sessionId: 'merged', action: 'delete', ok: false, message: 'Not removed: 1 uncommitted file.' }, { sessionId: 'gone', action: 'forget', ok: true, message: 'Forgotten' }] });
    act(() => root.render(createElement(CleanupTab, { onOpenSession: vi.fn(), api })));
    await flush();
    expect(text(container.querySelector('.wd-cleanup-results'))).toBe('1 done. 1 left alone: merged — Not removed: 1 uncommitted file.');
  });
});
