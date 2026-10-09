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
const search = () => container.querySelector<HTMLInputElement>('.wd-dash-rail-search')!;
const type = (text: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(search(), text);
    search().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const key = (el: EventTarget, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

describe('SessionRail search', () => {
  it('filters as you type, older sessions included, and drag is off meanwhile', () => {
    render();
    expect(names()).toEqual(['tmp/encryption-keys', 'fix/retries']); // by project (acme, then jobly); the old one is hidden
    type('jobly');
    expect(names().sort()).toEqual(['feat/old-dashboard', 'fix/retries']);
    expect(container.querySelector('li[draggable="true"]')).toBeNull();
    type('nothing-like-this');
    expect(container.textContent).toContain('No session matches');
  });

  it('/ focuses it, Enter opens the first result, Esc clears it', () => {
    const onSelect = render();
    key(window, '/');
    expect(document.activeElement).toBe(search());
    type('encryption');
    key(search(), 'Enter');
    expect(onSelect).toHaveBeenCalledWith('a');
    key(search(), 'Escape');
    expect(search().value).toBe('');
    expect(names()).toHaveLength(2);
  });
});

describe('PRs in the rail', () => {
  it('show as a pill on the row, which opens the PR', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const pr = {
      number: 3509,
      title: 't',
      branch: 'fix/retries',
      url: 'https://github.com/o/r/pull/3509',
      isDraft: false,
      checksStatus: 'SUCCESS',
      reviewDecision: 'NONE',
      myReview: 'NONE',
      isMine: true,
      repoAlias: 'jobly',
    } as PrInfo;
    render({ prsFor: (s) => (s.id === 'b' ? [pr] : []) });
    // A pill per open PR on its row: a click opens the PR, not the session.
    const pill = container.querySelector<HTMLElement>('.wd-pr-chip')!;
    expect(pill.textContent).toBe('#3509');
    act(() => pill.click());
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/3509', '_blank', 'noopener');
  });
});
