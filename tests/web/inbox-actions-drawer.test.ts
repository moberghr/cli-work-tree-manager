// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';
import { InboxTab } from '../../src/web/src/components/Dashboard/tabs/InboxTab.js';
import { DashboardLayout } from '../../src/web/src/components/Dashboard/DashboardLayout.js';
import { DEFAULT_ROUTE } from '../../src/web/src/state/dashboard-route.js';

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

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const att = (state: SessionAttention['state'], seen: boolean, summary?: string): SessionAttention => ({
  state,
  seen,
  since: minsAgo(3),
  updatedAt: minsAgo(3),
  summary,
  stale: false,
});
const s = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  target: 'api',
  branch: over.id,
  isGroup: false,
  paths: [`/wt/${over.id}`],
  createdAt: minsAgo(1000),
  lastAccessedAt: minsAgo(10),
  activityState: 'stale',
  ...over,
});
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('Inbox: a pull request that wants you', () => {
  const stage = (kind: 'ready' | 'in_review', text: string) => ({
    kind,
    text,
    key: `${kind}:api@abc`,
    prs: [{ repo: 'api', number: 209, url: 'https://github.com/o/api/pull/209', kind }],
  });

  it('ready to merge is a row of its own (its stage, the terminal, Mark seen with the stage); in review only counts in the closing line', () => {
    const onOpen = vi.fn();
    const onMarkSeen = vi.fn(() => Promise.resolve());
    const sessions = [
      s({ id: 'ready', attention: att('idle', true), prStage: stage('ready', 'PR #209 · approved, ready to merge') }),
      s({ id: 'waiting', attention: att('idle', true), prStage: stage('in_review', 'PR #210 · waiting for review') }),
    ];
    act(() => root.render(createElement(InboxTab, { sessions, onOpenSession: onOpen, onMarkSeen })));
    const items = [...container.querySelectorAll('.wd-inbox-item')];
    expect(items).toHaveLength(1);
    expect(text(items[0])).toContain('PR #209 · approved, ready to merge');
    expect(items[0].querySelector('.wd-rail-dot-pr')).not.toBeNull();
    const btn = (label: string) =>
      [...items[0].querySelectorAll<HTMLButtonElement>('.wd-inbox-actions button')].find((b) => b.textContent === label)!;
    act(() => btn('Open').click());
    expect(onOpen).toHaveBeenCalledWith('ready', 'term', undefined);
    act(() => btn('Mark seen').click());
    expect(onMarkSeen).toHaveBeenCalledWith('ready', expect.objectContaining({ kind: 'ready', key: 'ready:api@abc' }));
    expect(text(container.querySelector('.wd-inbox-rest'))).toContain('1 in review');
  });
});

describe('Inbox row actions', () => {
  const SESSIONS = [
    s({ id: 'blocked', attention: att('needs_input', false, 'Needs Bash'), diffStat: { added: 2, deleted: 0, files: 1 } }),
    s({ id: 'done', attention: att('idle', false, 'Added tests') }),
    s({ id: 'archived-done', attention: att('idle', false, 'x'), archivedAt: minsAgo(1) }),
  ];

  it('Open / Review open the right sub-tab, Terminal is there on hover; Mark seen only on finished rows, with progress', async () => {
    const onOpen = vi.fn();
    let resolve!: () => void;
    const onMarkSeen = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession: onOpen, onMarkSeen })));

    const items = [...container.querySelectorAll('.wd-inbox-item')];
    expect(items).toHaveLength(2); // archived hidden
    const [blocked, done] = items;
    const btn = (el: Element, label: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('.wd-inbox-actions button')].find((b) => b.textContent === label);

    expect(btn(blocked, 'Mark seen')).toBeUndefined();
    expect(btn(blocked, 'Terminal')).toBeUndefined(); // it opens there anyway
    act(() => btn(blocked, 'Open')!.click());
    act(() => btn(done, 'Review')!.click());
    act(() => btn(done, 'Terminal')!.click());
    expect(onOpen.mock.calls).toEqual([
      ['blocked', 'term', undefined],
      ['done', 'diff', { lastTurn: true }],
      ['done', 'term'],
    ]);

    act(() => btn(done, 'Mark seen')!.click());
    expect(onMarkSeen).toHaveBeenCalledWith('done', null);
    const marking = [...done.querySelectorAll('button')].find((b) => b.textContent === 'Marking…')!;
    expect(marking.disabled).toBe(true);
    await act(async () => resolve());
    expect(btn(done, 'Mark seen')).toBeDefined();
  });

  it('rows keep to name, what and when: no diff size or chips', () => {
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession: () => {} })));
    expect(container.querySelector('.wd-inbox-item .wd-diffstat')).toBeNull();
    expect(text(container.querySelector('.wd-inbox-item .wd-inbox-summary'))).toBe('Needs Bash');
  });
});

describe('narrow-layout session drawer', () => {
  const render = (onSelectSession = vi.fn()) => {
    act(() =>
      root.render(
        createElement(DashboardLayout, {
          route: DEFAULT_ROUTE,
          sessions: [s({ id: 'feat/a' })],
          onSelectTab: () => {},
          onSelectSession,
          onHome: () => {},
          onNewWorktree: () => {},
          children: createElement('div', null, 'main'),
        }),
      ),
    );
    return onSelectSession;
  };
  const body = () => container.querySelector('.wd-dash-body')!;
  const toggle = () => container.querySelector<HTMLButtonElement>('.wd-dash-rail-toggle')!;

  it('is closed by default and toggles from the ☰ button', () => {
    render();
    expect(body().className).not.toContain('wd-dash-rail-open');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    act(() => toggle().click());
    expect(body().className).toContain('wd-dash-rail-open');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.wd-dash-rail-backdrop')).not.toBeNull();
  });

  it('closes when the route changes from elsewhere (inbox click, `n`, back/forward)', () => {
    render();
    act(() => toggle().click());
    expect(body().className).toContain('wd-dash-rail-open');
    act(() =>
      root.render(
        createElement(DashboardLayout, {
          route: { tab: 'inbox', sessionId: 'feat/a', sessionSubTab: 'term' },
          sessions: [s({ id: 'feat/a' })],
          onSelectTab: () => {},
          onSelectSession: () => {},
          onHome: () => {},
          onNewWorktree: () => {},
          children: createElement('div', null, 'main'),
        }),
      ),
    );
    expect(body().className).not.toContain('wd-dash-rail-open');
  });

  it('closes on selecting a session, on Escape, and on a backdrop click', () => {
    const onSelect = render();
    act(() => toggle().click());
    act(() => container.querySelector<HTMLButtonElement>('.wd-dash-rail-item')!.click());
    expect(onSelect).toHaveBeenCalledWith('feat/a');
    expect(body().className).not.toContain('wd-dash-rail-open');

    act(() => toggle().click());
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(body().className).not.toContain('wd-dash-rail-open');

    act(() => toggle().click());
    act(() => container.querySelector<HTMLElement>('.wd-dash-rail-backdrop')!.click());
    expect(body().className).not.toContain('wd-dash-rail-open');
  });
});
