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
import { SESSION_ACTION_EVENT, type SessionAction } from '../../src/web/src/state/shortcuts.js';

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
    // Each with its key (state/shortcuts.ts).
    expect(menuItems()).toEqual(['Catch me upr', 'Notes⇧N', 'RenameF2', 'Delete…⇧Del']);
  });

  it('⋯ lists the rest, with how full the context is at the bottom; a second click closes it', async () => {
    h.dev = { port: 3017, listening: false, url: null, command: 'npm run dev', repo: 'repo', running: null };
    await render({ ...base, context: { used: 24_000, window: 200_000 } });
    act(() => more().click());
    expect(menuItems()).toEqual([
      'Open in terminal⇧T',
      'Ship (push, PR, merge)…⇧S',
      'Catch me upr',
      'Send a prompt…p',
      'Notes⇧N',
      'Start dev server:3017 · ⇧D',
      'RenameF2',
      'Delete…⇧Del',
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
  const withPr = {
    ...base,
    openReviewThreads: 2,
    replyDrafts: 1,
    prStage: { kind: 'checks_failing', text: '', key: 'k', prs: [{ repo: 'repo', number: 212, url: 'u', kind: 'checks_failing' }] },
  } as unknown as SessionSummary;

  it('one line from the session row, and a button into the PR tab — nothing unfolds over the terminal', async () => {
    await render(withPr);
    const bar = container.querySelector('.wd-needs-you')!;
    expect(bar.textContent).toBe('Needs you2 open review threads · 1 reply to post · #212 checks failingPR tab ▸');
    expect(container.querySelector('.wd-replies')).toBeNull();
    act(() => bar.querySelector('button')!.click());
    expect(onSelectSubTab).toHaveBeenLastCalledWith('pr');
  });

  it('nothing waiting: no bar', async () => {
    await render({
      ...base,
      prStage: { kind: 'in_review', text: '', key: 'k', prs: [{ repo: 'repo', number: 212, url: 'u', kind: 'in_review' }] },
    } as unknown as SessionSummary);
    expect(container.querySelector('.wd-needs-you')).toBeNull();
  });
});

describe('sub-tabs', () => {
  it('Terminal, Diff (with how many files and comments), Timeline; PR only with a PR (its stage, what wants you)', async () => {
    await render({ ...base, diffStat: { files: 2, added: 10, deleted: 1 }, commentCount: 3 } as SessionSummary);
    const tabs = () => [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs()).toEqual(['Terminal', 'Diff· 2 files3', 'Timeline']);
    await render({
      ...base,
      openReviewThreads: 2,
      prStage: { kind: 'in_review', text: '', key: 'k', prs: [{ repo: 'repo', number: 212, url: 'u', kind: 'in_review' }] },
    } as unknown as SessionSummary);
    expect(tabs()).toEqual(['Terminal', 'Diff', 'PR· #212 waiting for review2', 'Timeline']);
  });

  it('the keys the dashboard hands it: . opens ⋯, ⇧T a terminal, ⇧D the dev server — only for its own session, not when archived', async () => {
    h.dev = { port: 3017, listening: false, url: null, command: 'npm run dev', repo: 'repo', running: null };
    const key = (id: string, action: SessionAction) =>
      act(() => void window.dispatchEvent(new CustomEvent(SESSION_ACTION_EVENT, { detail: { id, action } })));
    await render();
    key('other', 'menu');
    expect(menuItems()).toEqual([]);
    key('sess-1', 'menu');
    expect(menuItems().length).toBeGreaterThan(0);
    h.openInTerminal.mockResolvedValue(undefined);
    key('sess-1', 'terminal');
    expect(h.openInTerminal).toHaveBeenCalledWith('sess-1');
    key('sess-1', 'dev');
    await act(async () => {});
    expect(h.devActions).toEqual(['start']);

    h.openInTerminal.mockReset();
    await render({ ...base, archivedAt: '2026-09-02T00:00:00Z' });
    key('sess-1', 'terminal');
    expect(h.openInTerminal).not.toHaveBeenCalled();
  });

  it('a group with two PRs: one pill each, linked to its own PR, with its own state', async () => {
    const prStage = {
      kind: 'in_review' as const,
      text: 'PRs backend #12, frontend #8 · waiting for review',
      key: 'k',
      prs: [
        { repo: 'backend', number: 12, url: 'https://gh/backend/12', kind: 'ready' as const },
        { repo: 'frontend', number: 8, url: 'https://gh/frontend/8', kind: 'checks_failing' as const },
      ],
    };
    await render({ ...base, isGroup: true, prStage });
    const pills = [...container.querySelectorAll<HTMLAnchorElement>('.wd-session-strip a.wd-pr-stage')];
    expect(pills.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['backend #12 · ready to merge', 'https://gh/backend/12'],
      ['frontend #8 · checks failing', 'https://gh/frontend/8'],
    ]);
    expect(pills[0].className).toContain('wd-pr-stage-good');
    expect(pills[1].className).toContain('wd-pr-stage-bad');
  });
});
