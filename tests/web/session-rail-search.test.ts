// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';
import { sessionMatches } from '../../src/web/src/state/session-display.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recent = new Date().toISOString();
const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
const session = (id: string, target: string, branch: string, path: string, at = recent): SessionSummary =>
  ({
    id,
    target,
    branch,
    isGroup: false,
    paths: [path],
    createdAt: at,
    lastAccessedAt: at,
    draftCount: 0,
    commentCount: 0,
    claudeCount: 0,
    ptyStatus: 'idle',
    lastActivity: null,
    activityState: 'stale',
    pendingForClaudeCount: 0,
    attention: null,
    diffStat: null,
    archivedAt: null,
    port: null,
  }) as SessionSummary;
const SESSIONS = [
  session('a', 'acme-backend', 'tmp/encryption-keys', 'C:\\repos\\worktrees\\acme-backend-ai\\tmp-encryption-keys'),
  session('b', 'jobly', 'fix/retries', 'C:\\repos\\worktrees\\jobly\\fix-retries'),
  session('c', 'jobly', 'feat/old-dashboard', 'C:\\repos\\worktrees\\jobly\\feat-old-dashboard', old),
];

describe('sessionMatches', () => {
  it('matches every word anywhere: branch, repo, folder, any order and case', () => {
    expect(sessionMatches(SESSIONS[0], 'acme-backend-ai')).toBe(true); // the folder, not the alias
    expect(sessionMatches(SESSIONS[0], 'KEYS tmp')).toBe(true);
    expect(sessionMatches(SESSIONS[0], 'keys jobly')).toBe(false);
    expect(sessionMatches(SESSIONS[1], 'worktrees\\jobly')).toBe(true);
    expect(sessionMatches(SESSIONS[1], '   ')).toBe(true);
  });
});

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
  vi.restoreAllMocks();
});

const render = (props: Partial<Parameters<typeof SessionRail>[0]> = {}) => {
  const onSelect = vi.fn();
  act(() =>
    root.render(
      createElement(SessionRail, {
        sessions: SESSIONS,
        activeSessionId: null,
        onSelect,
        onNewWorktree: () => {},
        onReorder: () => {},
        ...props,
      }),
    ),
  );
  return onSelect;
};
const names = () => [...container.querySelectorAll('.wd-dash-rail-name')].map((n) => n.textContent);
const rowOf = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-item')].find(
    (b) => b.querySelector('.wd-dash-rail-name')?.textContent === name,
  )!;

describe('the rail has no search box (Ctrl+P or / finds a session by name)', () => {
  it('no field in its header, only the legend and New worktree; / leaves the list as it is', () => {
    render();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('.wd-dash-rail-header')!.querySelector('[aria-label="New worktree"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    });
    expect(names()).toEqual(['tmp/encryption-keys', 'fix/retries']); // by project (acme, then jobly); the old one is under Older
    expect(document.activeElement).toBe(document.body);
  });
});

const pr = (n: number, extra: Partial<PrInfo> = {}) =>
  ({
    number: n,
    title: 't',
    branch: 'fix/retries',
    url: `https://github.com/o/r/pull/${n}`,
    isDraft: false,
    checksStatus: 'SUCCESS',
    reviewDecision: 'NONE',
    myReview: 'NONE',
    isMine: true,
    repoAlias: 'jobly',
    ...extra,
  }) as PrInfo;

describe('PRs in the rail', () => {
  it('a dot per PR on its row, saying which on hover; a click opens the PR, not the session; its number is in the row’s tooltip', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onSelect = render({ prsFor: (s) => (s.id === 'b' ? [pr(3509), pr(3510, { isDraft: true })] : []) });
    const marks = [...rowOf('fix/retries').querySelectorAll<HTMLElement>('.wd-rail-pr-mark')];
    expect(marks.map((m) => m.title)).toEqual(['jobly #3509 · open\nClick to open it', 'jobly #3510 · draft\nClick to open it']);
    expect(marks.map((m) => m.textContent)).toEqual(['', '']); // a dot, not the number
    expect(marks[1].className).toContain('wd-rail-pr-mark-draft');
    act(() => marks[0].click());
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/3509', '_blank', 'noopener');
    expect(onSelect).not.toHaveBeenCalled();
    expect(rowOf('fix/retries').title).toContain('PRs jobly #3509 · open, jobly #3510 · draft');
    expect(rowOf('tmp/encryption-keys').querySelector('.wd-rail-pr-marks')).toBeNull();
  });

  it('seven PRs: five dots and +2, and the project is still there, in its own place', () => {
    render({ prsFor: (s) => (s.id === 'b' ? Array.from({ length: 7 }, (_, i) => pr(100 + i)) : []) });
    const row = rowOf('fix/retries');
    expect(row.querySelectorAll('.wd-rail-pr-mark')).toHaveLength(5);
    expect(row.querySelector('.wd-rail-pr-more')?.textContent).toBe('+2');
    expect(row.querySelector('.wd-rail-pr-more')?.getAttribute('title')).toBe('jobly #105 · open\njobly #106 · open');
    expect(row.querySelector('.wd-dash-rail-sub .wd-dash-rail-summary')?.textContent).toBe('jobly');
  });
});

describe('a row: the same four places on every row', () => {
  it('line 1: the name (a branch’s prefix muted) and a time; line 2: the project and one status, keep, then the PR dots', () => {
    const owed = { ...SESSIONS[1], openReviewThreads: 2, keepAfterMerge: true } as SessionSummary;
    render({ sessions: [SESSIONS[0], owed], prsFor: (s) => (s.id === 'b' ? [pr(3509)] : []) });
    const row = rowOf('fix/retries');
    const [line1, line2] = [...row.querySelectorAll('.wd-dash-rail-line')];
    expect(line1.querySelector('.wd-dash-rail-prefix')?.textContent).toBe('fix/');
    expect(line1.querySelector('.wd-dash-rail-slot')?.textContent).toBe('just now'); // a time, never a badge
    expect(line1.querySelector('.wd-badge')).toBeNull();
    expect(
      [...line2.children].map((c) =>
        c.className.split(' ').find((k) => /^wd-(dash-rail-summary|rail-slot-owed|rail-keep|rail-pr-marks)$/.test(k)),
      ),
    ).toEqual(['wd-dash-rail-summary', 'wd-rail-slot-owed', 'wd-rail-keep', 'wd-rail-pr-marks']);
    expect(line2.querySelector('.wd-rail-slot-owed')?.textContent).toBe('2 threads');
    // Nothing owed, no PR: the project and nothing else.
    const plain = rowOf('tmp/encryption-keys');
    expect(plain.querySelector('.wd-dash-rail-sub')?.textContent).toBe('acme-backend');
  });
});
