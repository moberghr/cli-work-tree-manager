// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';
import { InboxTab, inboxRestLine } from '../../src/web/src/components/Dashboard/tabs/InboxTab.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';
import { TopNav } from '../../src/web/src/components/Dashboard/TopNav.js';
import { ContextChip, OverlapChip, formatTokens } from '../../src/web/src/components/Dashboard/SessionBits.js';

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
    id,
    target: 'repo',
    branch: id,
    isGroup: false,
    paths: [`/wt/${id}`],
    createdAt: minsAgo(1000),
    lastAccessedAt: minsAgo(lastAccessMins),
    attention,
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
  it('only what wants you, in inbox order; the rest is one line pointing to the rail', () => {
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession: () => {} })));
    const sections = [...container.querySelectorAll('.wd-inbox-section')];
    expect(sections.map((s) => text(s.querySelector('h2')))).toEqual(['Needs your input · 2', 'Done · 1']);
    const branches = [...container.querySelectorAll('.wd-inbox-branch')].map((b) => b.textContent);
    expect(branches).toEqual(['blocked-old', 'blocked-new', 'done']);
    expect(text(container.querySelector('h1'))).toBe('Inbox 3 need you');
    expect(text(container)).not.toContain('Press n');
    expect(text(container)).toContain('Claude needs your permission to use Edit');
    expect(text(container.querySelector('.wd-inbox-since'))).toBe('8m');
    expect(text(container.querySelector('.wd-inbox-rest'))).toBe("1 working, 2 quiet — they're in the list on the left."); // the untracked one is in the rail too
  });

  it('one action a row: Open for a question, Review for finished work', () => {
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession: () => {} })));
    const actions = [...container.querySelectorAll('.wd-inbox-actions')].map((a) =>
      [...a.querySelectorAll(':scope > button')].map((b) => b.textContent),
    );
    expect(actions).toEqual([['Open'], ['Open'], ['Review']]);
  });

  it('sessions with unresolved review comments get their own section, and count as needing you', () => {
    const withReview = [
      ...SESSIONS,
      { ...session('reviewed', att('idle', true, 300)), openReviewThreads: 3 },
      { ...session('reviewed-untracked', null), openReviewThreads: 1 },
      { ...session('reviewed-busy', att('working', true, 1)), openReviewThreads: 2 }, // mid-turn: Working wins
    ];
    act(() => root.render(createElement(InboxTab, { sessions: withReview, onOpenSession: () => {} })));
    const sections = [...container.querySelectorAll('.wd-inbox-section')].map((s) => text(s.querySelector('h2')));
    expect(sections).toEqual(['Needs your input · 2', 'Done · 1', 'Review comments · 2']);
    const review = [...container.querySelectorAll('.wd-inbox-section')][2];
    expect(text(review)).toContain('3 open threads');
    expect(text(review)).toContain('1 open thread');
    expect(review.querySelector('.wd-rail-dot-review')).not.toBeNull();
    expect(text(container.querySelector('h1'))).toBe('Inbox 5 need you');
    expect(text(container.querySelector('.wd-inbox-rest'))).toContain('2 working');
  });

  it('opens blocked sessions on the terminal and finished ones on the diff', () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession: onOpen })));
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.wd-inbox-row')];
    act(() => rows[0].click());
    act(() => rows[2].click());
    expect(onOpen.mock.calls).toEqual([
      ['blocked-old', 'term', undefined],
      ['done', 'diff', { lastTurn: true }],
    ]);
  });

  it('explains where status comes from when no session has reported yet', () => {
    act(() => root.render(createElement(InboxTab, { sessions: [session('a', null)], onOpenSession: () => {} })));
    expect(text(container)).toContain('No session has reported its status yet');
  });

  it('says so when nothing needs you', () => {
    act(() => root.render(createElement(InboxTab, { sessions: [session('q', att('idle', true, 5))], onOpenSession: () => {} })));
    expect(text(container)).toContain('Nothing needs you right now.');
    expect(text(container.querySelector('.wd-inbox-rest'))).toBe("1 quiet — it's in the list on the left.");
  });
});

describe('inboxRestLine', () => {
  it('says what the Inbox leaves to the rail, or nothing', () => {
    expect(inboxRestLine({ working: 1, quiet: 3, snoozed: 2, waiting: 1 })).toBe(
      "1 working, 3 quiet, 2 snoozed, 1 waiting on others — they're in the list on the left.",
    );
    expect(inboxRestLine({ working: 0, quiet: 0, snoozed: 0, waiting: 0 })).toBeNull();
  });
});

describe('InboxTab: answering a permission prompt', () => {
  const bash = { tool: 'Bash', detail: 'npm test -- invoices' };
  const blocked = (running: boolean): SessionSummary => ({
    ...session('blocked', { ...att('needs_input', false, 2, 'Claude needs your permission to use Bash'), request: bash }),
    ptyStatus: running ? 'running' : 'idle',
  });
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

  it('shows the command, and Allow / Deny when the session runs in the PTY host', async () => {
    const onAnswer = vi.fn(async () => {});
    act(() => root.render(createElement(InboxTab, { sessions: [blocked(true)], onOpenSession: () => {}, onAnswer })));
    expect(text(container.querySelector('.wd-inbox-request'))).toBe('Bash npm test -- invoices');
    await act(async () => button('Allow')!.click());
    expect(onAnswer).toHaveBeenCalledWith('blocked', { answer: 'allow', request: bash });
    await act(async () => button('Deny')!.click());
    expect(onAnswer).toHaveBeenLastCalledWith('blocked', { answer: 'deny', request: bash });
  });

  it('a session outside the PTY host shows the command but no buttons (answer it in its terminal)', () => {
    act(() => root.render(createElement(InboxTab, { sessions: [blocked(false)], onOpenSession: () => {}, onAnswer: vi.fn() })));
    expect(text(container.querySelector('.wd-inbox-request'))).toContain('npm test -- invoices');
    expect(button('Allow')).toBeUndefined();
    expect(button('Open')).toBeDefined(); // the terminal, where it's answered
  });

  it("shows the server's reason when it refused to type", async () => {
    const onAnswer = vi.fn(async () => {
      throw new Error('The permission prompt is no longer on screen');
    });
    act(() => root.render(createElement(InboxTab, { sessions: [blocked(true)], onOpenSession: () => {}, onAnswer })));
    await act(async () => button('Allow')!.click());
    expect(text(container.querySelector('[role=alert]'))).toBe('The permission prompt is no longer on screen');
    expect(button('Allow')!.disabled).toBe(false); // can try again
  });
});

describe('InboxTab: review queue', () => {
  it('offers "Review all" on the Done section, and opens a done row on its last turn', () => {
    const onReviewAll = vi.fn();
    const onOpenSession = vi.fn();
    act(() => root.render(createElement(InboxTab, { sessions: SESSIONS, onOpenSession, onReviewAll })));
    const done = container.querySelector('.wd-inbox-rank-1')!;
    const btn = done.querySelector<HTMLButtonElement>('.wd-inbox-review-all')!;
    expect(btn.textContent).toBe('Review all');
    expect(container.querySelectorAll('.wd-inbox-review-all')).toHaveLength(1); // not on the other sections
    act(() => btn.click());
    expect(onReviewAll).toHaveBeenCalledOnce();
    act(() => done.querySelector<HTMLButtonElement>('.wd-inbox-row')!.click());
    expect(onOpenSession).toHaveBeenCalledWith('done', 'diff', { lastTurn: true });
  });
});

describe('OverlapChip', () => {
  const withOverlaps = (overlaps: SessionSummary['overlaps']): SessionSummary => ({ ...session('me', null), overlaps });
  const o = (branch: string, count: number) => ({
    sessionId: branch,
    target: 'api',
    branch,
    count,
    files: [{ repo: 'api', path: 'package.json' }],
  });

  it('names the sessions that change the same files, lists them on hover, and links in the header', () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(OverlapChip, { session: withOverlaps([o('chore/deps', 3)]), onOpen })));
    const chip = container.querySelector('.wd-overlap')!;
    expect(text(chip)).toBe('⚠ Same files as chore/deps (3 files)');
    expect(chip.getAttribute('title')).toContain('Also changed by api · chore/deps:\n  api/package.json, and 2 more');
    act(() => chip.querySelector('button')!.click());
    expect(onOpen).toHaveBeenCalledWith('chore/deps');
  });

  it('is plain text in rows, summarizes past two, and renders nothing without overlaps', () => {
    act(() => root.render(createElement(OverlapChip, { session: withOverlaps([o('a', 1), o('b', 1), o('c', 1)]) })));
    expect(container.querySelector('.wd-overlap button')).toBeNull();
    expect(text(container)).toBe('⚠ Same files as a, b +1 (3 files)');
    act(() => root.render(createElement(OverlapChip, { session: withOverlaps(undefined) })));
    expect(container.innerHTML).toBe('');
  });
});

describe('ContextChip', () => {
  const at = (used: number): SessionSummary => ({ ...session('me', null), context: { used, window: 200_000, model: 'claude-sonnet-5' } });
  const chip = () => container.querySelector('.wd-ctx');

  it('shows how full the conversation is, and warns as it fills', () => {
    act(() => root.render(createElement(ContextChip, { session: at(40_000) })));
    expect(text(chip())).toBe('Context 20%');
    expect(chip()!.className).toContain('wd-ctx-ok');
    expect(chip()!.getAttribute('title')).toBe('40k of 200k tokens in this conversation (claude-sonnet-5).');
    act(() => root.render(createElement(ContextChip, { session: at(150_000) })));
    expect(chip()!.className).toContain('wd-ctx-warn');
    expect(chip()!.getAttribute('title')).toContain('start fresh');
    act(() => root.render(createElement(ContextChip, { session: at(195_000) })));
    expect(chip()!.className).toContain('wd-ctx-full');
  });

  it('nothing before the first reply', () => {
    act(() => root.render(createElement(ContextChip, { session: { ...session('me', null), context: null } })));
    expect(container.innerHTML).toBe('');
    expect([formatTokens(950), formatTokens(124_400), formatTokens(1_000_000)]).toEqual(['950', '124k', '1.0M']);
  });
});

describe('SessionRail with attention', () => {
  it('keeps a STABLE order (project, then most recent) and marks what wants you; urgency order is the inbox job', () => {
    act(() =>
      root.render(createElement(SessionRail, { sessions: SESSIONS, activeSessionId: null, onSelect: () => {}, onNewWorktree: () => {} })),
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

  it('colours a session with unresolved review comments, and says how many', () => {
    const list = [{ ...session('reviewed', att('idle', true, 300)), openReviewThreads: 2 }];
    act(() =>
      root.render(createElement(SessionRail, { sessions: list, activeSessionId: null, onSelect: () => {}, onNewWorktree: () => {} })),
    );
    const item = container.querySelector('.wd-dash-rail-item')!;
    expect(item.querySelector('.wd-rail-dot')!.className).toContain('wd-rail-dot-review');
    expect(item.querySelector('.wd-rail-dot')!.getAttribute('aria-label')).toBe('Review comments');
    expect(text(item.querySelector('.wd-rail-slot-review'))).toBe('2'); // the icon says what it counts
  });

  it('keeps an old selected session visible even with 40+ current ones', () => {
    // 45 entered in the last few minutes (current) + 3 from a month ago (older).
    const recent = Array.from({ length: 45 }, (_, i) => session(`cur-${i}`, null, 1 + i));
    const old = ['old-a', 'old-b', 'old-c'].map((id) => session(id, null, 60 * 24 * 30));
    act(() =>
      root.render(
        createElement(SessionRail, {
          sessions: [...recent, ...old],
          activeSessionId: 'old-b',
          onSelect: () => {},
          onNewWorktree: () => {},
        }),
      ),
    );
    const names = [...container.querySelectorAll('.wd-dash-rail-name')].map((n) => n.textContent);
    expect(names).toHaveLength(46); // every current one + the selected old one
    expect(names).toContain('old-b');
    expect(text(container)).toContain('+2 older');
  });
});

describe('TopNav inbox badge', () => {
  const render = (inboxCount: number) =>
    act(() => root.render(createElement(TopNav, { active: 'sessions', onSelect: () => {}, onHome: () => {}, inboxCount })));

  it('shows the count on the Inbox tab only when something needs you', () => {
    render(3);
    const inbox = [...container.querySelectorAll('.wd-dash-tab')].find((t) => t.textContent?.startsWith('Inbox'))!;
    expect(inbox.querySelector('.wd-dash-tab-badge')?.textContent).toBe('3');
    render(0);
    expect(container.querySelector('.wd-dash-tab-badge')).toBeNull();
  });
});
