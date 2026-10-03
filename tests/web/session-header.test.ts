// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DevServerState, SessionCi, SessionSummary } from '../../src/web/src/api/client.js';
import type { RepliesWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  openInTerminal: vi.fn(),
  dev: null as DevServerState | null,
  devActions: [] as string[],
  ci: { repos: [] } as unknown as SessionCi,
  replies: { replies: [], waiting: [] } as RepliesWire,
}));

vi.mock('../../src/web/src/api/panes.js', () => ({ openInTerminal: h.openInTerminal }));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchDevState: async () => h.dev,
  devAction: async (_id: string, a: string) => {
    h.devActions.push(a);
  },
  fetchSessionCi: async () => h.ci,
  fetchReplies: async () => h.replies,
  fetchWorkTime: async () => ({ totalMs: 0, byDay: [] }),
  fetchTimeline: async () => ({ events: [] }),
}));
// Keep the detail view light: the header is what's under test.
vi.mock('../../src/web/src/components/Diff/DiffView.js', () => ({ DiffView: () => null }));
vi.mock('../../src/web/src/components/Terminal/PtyView.js', () => ({ PtyView: () => null }));
vi.mock('../../src/web/src/components/Dashboard/TimelineView.js', () => ({ TimelineView: () => null }));

import { SessionDetail } from '../../src/web/src/components/Dashboard/SessionDetail.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.openInTerminal.mockReset();
  h.dev = null;
  h.devActions = [];
  h.ci = { repos: [] } as unknown as SessionCi;
  h.replies = { replies: [], waiting: [] };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base: SessionSummary = {
  id: 'sess-1',
  target: 'repo',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/tmp/repo'],
  createdAt: '2026-09-01T00:00:00Z',
  lastAccessedAt: new Date().toISOString(),
};

const onDelete = vi.fn();
const onSelectSubTab = vi.fn();
async function render(session: SessionSummary = base) {
  await act(async () => {
    root.render(createElement(SessionDetail, { session, subTab: 'term', onSelectSubTab, onDelete }));
  });
  await act(async () => {});
}

const header = () => container.querySelector('.wd-session-detail-header')!;
const buttonsIn = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
const more = () => container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
const item = (label: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => label.test(b.textContent ?? ''))!;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('session header', () => {
  it('shows target / branch, then only Archive and ⋯', async () => {
    await render();
    expect(header().querySelector('h1')!.textContent).toBe('repo/feat/x');
    expect(buttonsIn(header())).toEqual(['Archive', '⋯']);
  });

  it('an archived one offers Restore, and its menu only what reads, names or deletes it', async () => {
    await render({ ...base, archivedAt: '2026-09-02T00:00:00Z' });
    expect(buttonsIn(header())).toEqual(['Restore', '⋯']);
    act(() => more().click());
    expect(menuItems()).toEqual(['Catch me up', 'Notes', 'RenameF2', 'Delete…']);
  });

  it('⋯ lists the rest, with how full the context is at the bottom; a second click closes it', async () => {
    h.dev = { port: 3017, listening: false, url: null, command: 'npm run dev', repo: 'repo', running: null };
    await render({ ...base, context: { used: 24_000, window: 200_000 } });
    act(() => more().click());
    expect(menuItems()).toEqual([
      'Open in terminal',
      'Ship (push, PR, merge)…',
      'Catch me up',
      'Send a prompt…',
      'Notes',
      'Start dev server:3017',
      'RenameF2',
      'Delete…',
    ]);
    expect(document.querySelector('.wd-row-menu-footer')!.textContent).toBe('Context 12% · 24k of 200k tokens');
    act(() => {
      more().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      more().click();
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('starts the dev server from the menu', async () => {
    h.dev = { port: 3017, listening: false, url: null, command: 'npm run dev', repo: 'repo', running: null };
    await render();
    act(() => more().click());
    await act(async () => item(/Start dev server/).click());
    expect(h.devActions).toEqual(['start']);
  });

  it('Delete… asks the dashboard to confirm', async () => {
    onDelete.mockClear();
    await render();
    act(() => more().click());
    act(() => item(/Delete/).click());
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('Rename opens the name field in the header', async () => {
    await render();
    act(() => more().click());
    act(() => item(/Rename/).click());
    expect(header().querySelector<HTMLInputElement>('.wd-session-title-input')).not.toBeNull();
  });

  it('Ship opens the Ship panel', async () => {
    await render();
    act(() => more().click());
    act(() => item(/Ship/).click());
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Ship session');
  });

  it('Open in terminal says it is opening until the request settles', async () => {
    const d = deferred<{ ok: true }>();
    h.openInTerminal.mockReturnValue(d.promise);
    await render();
    act(() => more().click());
    act(() => item(/Open in terminal/).click());
    expect(h.openInTerminal).toHaveBeenCalledWith('sess-1');
    expect(header().textContent).toContain('Opening in a terminal…');
    await act(async () => d.resolve({ ok: true }));
    expect(header().textContent).not.toContain('Opening');
  });

  it('a failed Open in terminal says why', async () => {
    h.openInTerminal.mockRejectedValue(new Error('Only Windows Terminal is supported so far'));
    await render();
    act(() => more().click());
    await act(async () => item(/Open in terminal/).click());
    expect(header().querySelector('[role="alert"]')!.textContent).toBe('Only Windows Terminal is supported so far');
  });
});

describe('status line', () => {
  it('stays quiet: no context below 70%, no "running in the app", no notes chip without a note', async () => {
    await render({
      ...base,
      context: { used: 20_000, window: 200_000 },
      agents: { total: 1, inTerminal: 0, inApp: 1, busy: false, duplicate: false },
    } as SessionSummary);
    const strip = container.querySelector('.wd-session-strip')!;
    expect(strip.querySelector('.wd-ctx')).toBeNull();
    expect(strip.querySelector('.wd-claudes')).toBeNull();
    expect(strip.querySelector('.wd-notes-chip')).toBeNull();
  });

  it('speaks up when it matters: context past 70%, a Claude in an outside terminal, a note', async () => {
    await render({
      ...base,
      hasNote: true,
      context: { used: 168_000, window: 200_000 },
      agents: { total: 1, inTerminal: 1, inApp: 0, busy: false, duplicate: false },
    } as SessionSummary);
    const strip = container.querySelector('.wd-session-strip')!;
    expect(strip.querySelector('.wd-ctx')!.textContent).toContain('84%');
    expect(strip.querySelector('.wd-claudes')!.textContent).toBe('Running in terminal');
    expect(strip.querySelector('.wd-notes-chip')).not.toBeNull();
  });
});

describe('Needs you', () => {
  it('folds reply drafts and failing CI into one line; Review unfolds them', async () => {
    h.replies = {
      replies: [{ threadId: 'T1', prNumber: 212, reviewer: 'ana', excerpt: 'Rename this', url: 'u', status: 'draft', draft: 'Done.' }],
      waiting: [],
    } as unknown as RepliesWire;
    h.ci = {
      repos: [{ name: 'repo', pr: { number: 212, state: 'OPEN', checks: 'fail', url: 'u', failing: [] } }],
    } as unknown as SessionCi;
    await render();
    const bar = container.querySelector('.wd-needs-you')!;
    expect(bar.textContent).toBe('Needs you1 reply to post · CI failing on #212Review');
    expect(container.querySelector<HTMLElement>('.wd-replies')!.hidden).toBe(true);
    expect(container.querySelector<HTMLElement>('.wd-ci-strip')!.hidden).toBe(true);
    act(() => bar.querySelector('button')!.click());
    expect(container.querySelector<HTMLElement>('.wd-replies')!.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>('.wd-ci-strip')!.hidden).toBe(false);
    expect(bar.querySelector('button')!.textContent).toBe('Hide');
  });

  it('nothing waiting: no bar, and running checks show as they are', async () => {
    h.ci = {
      repos: [{ name: 'repo', pr: { number: 212, state: 'OPEN', checks: 'pending', url: 'u' } }],
    } as unknown as SessionCi;
    await render();
    expect(container.querySelector('.wd-needs-you')).toBeNull();
    expect(container.querySelector<HTMLElement>('.wd-ci-strip')!.hidden).toBe(false);
  });
});

describe('sub-tabs', () => {
  it('Terminal, Diff (with how many files and comments), Timeline', async () => {
    await render({ ...base, diffStat: { files: 2, added: 10, deleted: 1 }, commentCount: 3 } as SessionSummary);
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Terminal', 'Diff· 2 files3', 'Timeline']);
  });
});
