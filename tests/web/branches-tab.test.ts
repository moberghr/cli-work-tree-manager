// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionHistoryWire } from '../../src/core/api-types.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Branches tab (#/s/<id>/branches): its rows, Show in Diff, and a read that failed once then worked. */

const h = vi.hoisted(() => ({
  events: {} as Record<string, () => void>,
  answers: [] as Array<SessionHistoryWire | Error>,
}));
vi.mock('../../src/web/src/api/events.js', () => ({
  useSse: (_url: string, opts: { events: Record<string, () => void> }) => {
    h.events = opts.events;
  },
}));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchSessionHistory: async () => {
    const next = h.answers.shift();
    if (!next || next instanceof Error) throw next ?? new Error('no answer');
    return next;
  },
}));

const { BranchesTab } = await import('../../src/web/src/components/Dashboard/BranchesTab.js');

const at = '2026-11-03T10:00:00Z';
const session = {
  id: 's1',
  target: 'api',
  branch: 'feat/orders',
  isGroup: false,
  paths: ['/wt/api'],
  branches: [
    { repo: 'api', name: 'feat/export', current: true, firstSeen: at, lastSeen: at, commits: 1, pushed: false },
    { repo: 'api', name: 'fix/refunds', current: false, firstSeen: at, lastSeen: at, commits: 1, pushed: true, unpushed: 0 },
  ],
} as unknown as SessionSummary;
const history: SessionHistoryWire = {
  scopeHash: 'x',
  entries: [{ id: 1, ts: at, repos: {}, branches: { api: 'fix/refunds' } }],
  commits: [{ repo: 'api', sha: 'a'.repeat(40), at, subject: 'Refund rounding', branch: 'fix/refunds' }],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  h.answers = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
};

describe('the Branches tab', () => {
  it('lists each branch; Show in Diff opens the other one in the Diff tab, the checked-out one the Diff as it is', async () => {
    h.answers.push(history);
    const onShowBranch = vi.fn();
    const onShowDiff = vi.fn();
    act(() => root.render(createElement(BranchesTab, { session, onShowBranch, onShowDiff })));
    await flush();
    const rows = [...container.querySelectorAll('.wd-branches-tab-row')];
    expect(rows.map((r) => r.querySelector('.wd-branches-tab-name')?.textContent)).toEqual(['feat/export', 'fix/refunds']);
    expect(rows[1].textContent).toContain('turn 1');
    const show = (i: number) => rows[i].querySelector<HTMLButtonElement>('.wd-branches-tab-show')!;
    act(() => show(1).click());
    expect(onShowBranch).toHaveBeenCalledWith('api', 'fix/refunds');
    act(() => show(0).click());
    expect(onShowDiff).toHaveBeenCalled();
  });

  it('a read that failed is said; the next one that works shows the branches, not the old error (review finding)', async () => {
    h.answers.push(new Error('HTTP 502'), history);
    act(() => root.render(createElement(BranchesTab, { session, onShowBranch: () => {}, onShowDiff: () => {} })));
    await flush();
    expect(container.textContent).toContain('Couldn’t read its history: HTTP 502');
    act(() => h.events['checkpoints-changed']());
    await flush();
    expect(container.textContent).not.toContain('Couldn’t read');
    expect(container.querySelectorAll('.wd-branches-tab-row')).toHaveLength(2);
  });
});
