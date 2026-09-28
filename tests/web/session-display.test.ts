// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import {
  defaultSubTab,
  displayStatus,
  formatDiffStat,
  prsForSession,
  stableSessionOrder,
  statusBucket,
} from '../../src/web/src/state/session-display.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const att = (state: SessionAttention['state'], seen: boolean, summary?: string): SessionAttention => ({
  state, seen, since: minsAgo(3), updatedAt: minsAgo(3), summary, stale: false,
});
function s(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    target: 'api', branch: over.id, isGroup: false, paths: [`/wt/${over.id}`],
    createdAt: minsAgo(1000), lastAccessedAt: minsAgo(100), activityState: 'stale',
    ...over,
  };
}
const pr = (over: Partial<PrInfo>): PrInfo => ({
  number: 1, title: 't', branch: 'b', url: 'https://x/pr/1', isDraft: false,
  checksStatus: 'SUCCESS', reviewDecision: 'NONE', myReview: 'NONE', isMine: true, repoAlias: 'api',
  ...over,
});

describe('displayStatus — one vocabulary for every view', () => {
  it('prefers hook attention and falls back to transcript activity', () => {
    expect(displayStatus(s({ id: 'a', attention: att('needs_input', false) }))).toBe('needs_input');
    expect(displayStatus(s({ id: 'a', attention: att('idle', false) }))).toBe('done');
    expect(displayStatus(s({ id: 'a', attention: att('idle', true) }))).toBe('quiet');
    expect(displayStatus(s({ id: 'a', attention: att('working', true) }))).toBe('working');
    // attention wins even when activity says otherwise
    expect(displayStatus(s({ id: 'a', attention: att('working', true), activityState: 'stale' }))).toBe('working');
    expect(displayStatus(s({ id: 'a', activityState: 'active' }))).toBe('active');
    expect(displayStatus(s({ id: 'a', activityState: 'open' }))).toBe('open');
    expect(displayStatus(s({ id: 'a' }))).toBe('stale');
  });

  it('buckets for the Sessions header and filter', () => {
    expect(statusBucket('needs_input')).toBe('needs');
    expect(statusBucket('done')).toBe('needs');
    expect(statusBucket('working')).toBe('working');
    expect(statusBucket('active')).toBe('working');
    expect(statusBucket('quiet')).toBe('idle');
    expect(statusBucket('open')).toBe('idle');
    expect(statusBucket('stale')).toBe('stale');
  });

  it('opens blocked/working sessions on the terminal, the rest on the diff', () => {
    expect(defaultSubTab(s({ id: 'a', attention: att('needs_input', false) }))).toBe('term');
    expect(defaultSubTab(s({ id: 'a', attention: att('working', true) }))).toBe('term');
    expect(defaultSubTab(s({ id: 'a', attention: att('idle', false) }))).toBe('diff');
    expect(defaultSubTab(s({ id: 'a' }))).toBe('diff');
  });

  it('stable order: project, then most recently entered — ignores status', () => {
    const list = [
      s({ id: 'z-old', target: 'web', lastAccessedAt: minsAgo(50) }),
      s({ id: 'blocked', target: 'api', lastAccessedAt: minsAgo(90), attention: att('needs_input', false) }),
      s({ id: 'recent', target: 'api', lastAccessedAt: minsAgo(1) }),
    ];
    expect(stableSessionOrder(list).map((x) => x.id)).toEqual(['recent', 'blocked', 'z-old']);
  });

  it('matches PRs by branch and repo alias (any alias for groups)', () => {
    const prs = [pr({ number: 1, branch: 'feat/x', repoAlias: 'api' }), pr({ number: 2, branch: 'feat/x', repoAlias: 'web' })];
    expect(prsForSession(s({ id: 'x', branch: 'feat/x', target: 'api' }), prs).map((p) => p.number)).toEqual([1]);
    expect(prsForSession(s({ id: 'x', branch: 'feat/x', target: 'shop', isGroup: true }), prs).map((p) => p.number)).toEqual([1, 2]);
    expect(prsForSession(s({ id: 'x', branch: 'other' }), prs)).toEqual([]);
  });

  it('formats diff stats, hiding empty ones', () => {
    expect(formatDiffStat(s({ id: 'a', diffStat: { added: 12, deleted: 3, files: 2 } }))).toBe('+12 −3');
    expect(formatDiffStat(s({ id: 'a', diffStat: { added: 0, deleted: 0, files: 0 } }))).toBeNull();
    expect(formatDiffStat(s({ id: 'a', diffStat: null }))).toBeNull();
  });
});

describe('SessionRail rows', () => {
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

  it('shows branch, target · summary, diff size and the PR badge; hides archived', () => {
    const sessions = [
      s({ id: 'feat/x', attention: att('needs_input', false, 'Claude needs your permission to use Bash'), diffStat: { added: 5, deleted: 1, files: 2 } }),
      s({ id: 'gone', archivedAt: minsAgo(5) }),
    ];
    const prs = [pr({ number: 42, branch: 'feat/x', checksStatus: 'FAILURE' })];
    act(() =>
      root.render(
        createElement(SessionRail, {
          sessions,
          activeSessionId: null,
          onSelect: () => {},
          onNewWorktree: () => {},
          prsFor: (x) => prsForSession(x, prs),
        }),
      ),
    );
    const rows = container.querySelectorAll('.wd-dash-rail-item');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.querySelector('.wd-dash-rail-name')?.textContent).toBe('feat/x');
    expect(row.querySelector('.wd-dash-rail-summary')?.textContent).toBe('api · Claude needs your permission to use Bash');
    expect(row.querySelector('.wd-dash-rail-stat')?.textContent).toBe('+5 −1');
    const chip = row.querySelector('.wd-pr-chip')!;
    expect(chip.textContent).toBe('#42 ✗');
    expect(chip.className).toContain('wd-pr-chip-failure');
    expect(row.querySelector('.wd-dash-rail-slot')?.textContent).toMatch(/^◆ /);
  });

  it('a quiet session shows a relative time and no summary suffix', () => {
    act(() =>
      root.render(
        createElement(SessionRail, {
          sessions: [s({ id: 'q', attention: att('idle', true) })],
          activeSessionId: null,
          onSelect: () => {},
          onNewWorktree: () => {},
        }),
      ),
    );
    expect(container.querySelector('.wd-dash-rail-summary')?.textContent).toBe('api');
    expect(container.querySelector('.wd-dash-rail-slot')?.textContent).toBe('3m');
    expect(container.querySelector('.wd-rail-dot')?.className).toContain('wd-rail-dot-quiet');
  });
});

describe('railSessions — hundreds of sessions (reviewed: active ones were hidden)', () => {
  const day = 24 * 60 * 60_000;
  const now = Date.parse('2026-09-29T12:00:00Z');
  const mk = (id: string, target: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
    ({ id, target, branch: id, isGroup: false, paths: [], createdAt: '', lastAccessedAt: new Date(now - daysAgo * day).toISOString(), ...extra }) as never;

  it('keeps current sessions (recent, reporting a status, or live) and parks the rest as older', async () => {
    const { railSessions } = await import('../../src/web/src/state/session-display.js');
    const sessions = [
      // 50 old sessions of an alphabetically-first project…
      ...Array.from({ length: 50 }, (_, i) => mk(`old-${i}`, 'app-templates', 200 + i)),
      // …must not push the active work off the rail.
      mk('active', 'straumur', 0),
      mk('old-but-blocked', 'straumur', 90, { attention: { state: 'needs_input', seen: false, since: '', updatedAt: '', stale: false } }),
      mk('old-but-live', 'warp', 90, { ptyStatus: 'running' }),
      mk('archived', 'straumur', 0, { archivedAt: '2026-09-01' }),
    ];
    const { current, older } = railSessions(sessions, now);
    expect(current.map((s: { id: string }) => s.id)).toEqual(['active', 'old-but-blocked', 'old-but-live']);
    expect(older).toHaveLength(50);
    expect([...current, ...older].some((s: { id: string }) => s.id === 'archived')).toBe(false);
  });
});
