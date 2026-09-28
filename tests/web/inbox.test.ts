// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';
import { InboxTab } from '../../src/web/src/components/Dashboard/tabs/InboxTab.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';
import { TopNav } from '../../src/web/src/components/Dashboard/TopNav.js';

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
function att(state: SessionAttention['state'], seen: boolean, mins: number, summary?: string): SessionAttention {
  return { state, seen, since: minsAgo(mins), updatedAt: minsAgo(mins), summary, stale: false };
}
function session(id: string, attention: SessionAttention | null, lastAccessMins = 100): SessionSummary {
  return {
    id, target: 'repo', branch: id, isGroup: false, paths: [`/wt/${id}`],
    createdAt: minsAgo(1000), lastAccessedAt: minsAgo(lastAccessMins), attention,
    activityState: 'stale',
  };
}

const SESSIONS = [
  session('working-a', att('working', true, 2, 'Refactoring the ledger')),
  session('blocked-new', att('needs_input', false, 1, 'Claude needs your permission to use Bash')),
  session('quiet', att('idle', true, 30)),
  session('done', att('idle', false, 10, 'Added the endpoint and tests')),
  session('blocked-old', att('needs_input', false, 8, 'Claude needs your permission to use Edit')),
  session('untracked', null, 1),
];

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('InboxTab', () => {
  it('groups by what you should do, in inbox order, and counts quiet ones', () => {
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession: () => {} })));
    const sections = [...container.querySelectorAll('.wd-inbox-section')];
    expect(sections.map((s) => text(s.querySelector('h2')))).toEqual([
      'Needs your input (2)',
      'Done — not looked at yet (1)',
      'Working (1)',
    ]);
    const branches = [...container.querySelectorAll('.wd-inbox-branch')].map((b) => b.textContent);
    expect(branches).toEqual(['blocked-old', 'blocked-new', 'done', 'working-a']);
    expect(text(container.querySelector('h1'))).toContain('3 need you · 1 working · 1 quiet');
    expect(text(container)).toContain('Claude needs your permission to use Edit');
    expect(text(container)).toContain('waiting 8m');
  });

  it('opens blocked sessions on the terminal and finished ones on the diff', () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession: onOpen })));
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.wd-inbox-row')];
    act(() => rows[0].click());
    act(() => rows[2].click());
    expect(onOpen.mock.calls).toEqual([['blocked-old', 'term'], ['done', 'diff']]);
  });

  it('explains where status comes from when no session has reported yet', () => {
    act(() => root.render(createElement(InboxTab, { sessions: [session('a', null)], onOpenSession: () => {} })));
    expect(text(container)).toContain("No session has reported its status yet");
  });

  it('says so when nothing needs you', () => {
    act(() => root.render(createElement(InboxTab, { sessions: [session('q', att('idle', true, 5))], onOpenSession: () => {} })));
    expect(text(container)).toContain('Nothing needs you right now.');
  });
});

describe('SessionRail with attention', () => {
  it('keeps a STABLE order (project, then most recent) and marks what wants you; urgency order is the inbox job', () => {
    act(() =>
      root.render(
        createElement(SessionRail, { sessions: SESSIONS, activeSessionId: null, onSelect: () => {}, onNewWorktree: () => {} }),
      ),
    );
    const names = [...container.querySelectorAll('.wd-dash-rail-name')].map((n) => n.textContent);
    // All target 'repo'; lastAccessedAt all 100m ago except 'untracked' (1m) — recency order, not attention.
    expect(names[0]).toBe('untracked');
    const byName = (n: string) =>
      [...container.querySelectorAll('.wd-dash-rail-item')].find((i) => i.querySelector('.wd-dash-rail-name')?.textContent === n)!;
    const blocked = byName('blocked-old');
    expect(blocked.className).toContain('wd-dash-rail-item-unseen');
    expect(blocked.querySelector('.wd-rail-dot')!.className).toContain('wd-rail-dot-needs_input');
    expect(blocked.getAttribute('title')).toContain('Claude needs your permission to use Edit');
    expect(byName('done').querySelector('.wd-rail-dot')!.className).toContain('wd-rail-dot-done');
  });
});

describe('TopNav inbox badge', () => {
  const render = (inboxCount: number) =>
    act(() =>
      root.render(createElement(TopNav, { active: 'sessions', onSelect: () => {}, onHome: () => {}, inboxCount })),
    );

  it('shows the count on the Inbox tab only when something needs you', () => {
    render(3);
    const inbox = [...container.querySelectorAll('.wd-dash-tab')].find((t) => t.textContent?.startsWith('Inbox'))!;
    expect(inbox.querySelector('.wd-dash-tab-badge')?.textContent).toBe('3');
    render(0);
    expect(container.querySelector('.wd-dash-tab-badge')).toBeNull();
  });
});
