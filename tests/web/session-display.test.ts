// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import {
  DISPLAY_LABEL,
  agentCan,
  agentName,
  displayStatus,
  ageBucket,
  formatDiffStat,
  lastActiveAt,
  owedBadge,
  prsForSession,
  sessionBucket,
  stableSessionOrder,
  statusBucket,
} from '../../src/web/src/state/session-display.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const att = (state: SessionAttention['state'], seen: boolean, summary?: string): SessionAttention => ({
  state,
  seen,
  since: minsAgo(3),
  updatedAt: minsAgo(3),
  summary,
  stale: false,
});
function s(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    target: 'api',
    branch: over.id,
    isGroup: false,
    paths: [`/wt/${over.id}`],
    createdAt: minsAgo(1000),
    lastAccessedAt: minsAgo(100),
    activityState: 'stale',
    ...over,
  };
}
const pr = (over: Partial<PrInfo>): PrInfo => ({
  number: 1,
  title: 't',
  branch: 'b',
  url: 'https://x/pr/1',
  isDraft: false,
  checksStatus: 'SUCCESS',
  reviewDecision: 'NONE',
  myReview: 'NONE',
  isMine: true,
  repoAlias: 'api',
  ...over,
});

describe('displayStatus — one vocabulary for every view', () => {
  it('being archived wins over everything: it is on its way out, and something is happening', () => {
    const k = displayStatus(s({ id: 'a', archiving: true, attention: att('needs_input', false), openReviewThreads: 2 }));
    expect(k).toBe('archiving');
    expect(DISPLAY_LABEL[k]).toBe('Archiving');
    expect(statusBucket(k)).toBe('working');
    expect(ageBucket(s({ id: 'b', archiving: true, lastAccessedAt: minsAgo(60 * 24 * 30) }))).toBe('now');
    expect(displayStatus(s({ id: 'c', restoring: true, archivedAt: minsAgo(60) }))).toBe('restoring');
    expect(DISPLAY_LABEL.restoring).toBe('Restoring');
    // Asleep (stopped while idle) in place of the idle ring — never over what wants you.
    expect(displayStatus(s({ id: 'd', asleep: true, attention: att('idle', true) }))).toBe('asleep');
    expect(displayStatus(s({ id: 'e', asleep: true, attention: att('idle', false) }))).toBe('done');
    expect(displayStatus(s({ id: 'f', asleep: true }))).toBe('asleep');
    expect(DISPLAY_LABEL.asleep).toBe('Asleep');
    expect(statusBucket('asleep')).toBe('idle');
  });

  it('prefers hook attention and falls back to transcript activity', () => {
    expect(displayStatus(s({ id: 'a', attention: att('needs_input', false) }))).toBe('needs_input');
    expect(displayStatus(s({ id: 'a', attention: att('idle', false) }))).toBe('done');
    expect(displayStatus(s({ id: 'a', attention: att('idle', true) }))).toBe('quiet');
    expect(displayStatus(s({ id: 'a', attention: att('working', true) }))).toBe('working');
    // attention wins even when activity says otherwise
    expect(displayStatus(s({ id: 'a', attention: att('working', true), activityState: 'stale' }))).toBe('working');
    expect(displayStatus(s({ id: 'a', activityState: 'active' }))).toBe('active');
    expect(displayStatus(s({ id: 'a', activityState: 'open' }))).toBe('open');
    // No hook status and quiet for 5 min: used today is Idle, older is Stale.
    expect(displayStatus(s({ id: 'a' }))).toBe('recent'); // entered 100 min ago
    expect(displayStatus(s({ id: 'a', lastAccessedAt: minsAgo(3 * 24 * 60) }))).toBe('stale');
    expect(displayStatus(s({ id: 'a', lastAccessedAt: minsAgo(3 * 24 * 60), lastActivity: Date.now() - 2 * 3_600_000 }))).toBe('recent');
  });

  it('working on a background agent its turn started is its own kind: In background (still busy, its prompt free)', () => {
    const bg = { ...att('working', true), background: { what: '/mtk:code-review-and-quality Re-review' } };
    expect(displayStatus(s({ id: 'a', attention: bg }))).toBe('background');
    expect(DISPLAY_LABEL.background).toBe('In background');
    // Busy, so it's "now", like working.
    expect(ageBucket(s({ id: 'a', attention: bg, lastAccessedAt: minsAgo(30 * 24 * 60) }))).toBe('now');
    // Without the mark (Claude's own turn, or an older server): working.
    expect(displayStatus(s({ id: 'a', attention: att('working', true) }))).toBe('working');
  });

  it('two signals: the status is what its Claude is doing; what waits on you (threads, replies) is its own, beside it', () => {
    const r = { openReviewThreads: 2 };
    expect(displayStatus(s({ id: 'a', ...r, attention: att('idle', true) }))).toBe('quiet');
    expect(displayStatus(s({ id: 'a', ...r, attention: att('idle', false) }))).toBe('done');
    expect(displayStatus(s({ id: 'a', ...r, attention: att('working', true) }))).toBe('working');
    expect(displayStatus(s({ id: 'a', ...r, attention: att('needs_input', false) }))).toBe('needs_input');
    for (const st of [att('idle', true), att('working', true), att('needs_input', false)])
      expect(owedBadge(s({ id: 'a', ...r, attention: st }))).toMatchObject({ text: '2 threads' });
    // A reply to post alone (reported: it read Idle with nothing beside it).
    expect(owedBadge(s({ id: 'a', replyDrafts: 1, attention: att('idle', true) }))).toEqual({
      text: '1 reply',
      title: 'Needs you: 1 reply to post',
    });
    expect(owedBadge(s({ id: 'a', attention: att('idle', true) }))).toBeNull();
    // The Sessions filter and the age sections count it as wanting you.
    expect(sessionBucket(s({ id: 'a', ...r, attention: att('working', true) }))).toBe('needs');
    expect(sessionBucket(s({ id: 'a', attention: att('working', true) }))).toBe('working');
    expect(ageBucket(s({ id: 'a', ...r, lastAccessedAt: minsAgo(30 * 24 * 60) }))).toBe('now');
  });

  it("'last active' is the newest of the hook update, Claude's last write and the entry", () => {
    const entry = minsAgo(24 * 60);
    expect(lastActiveAt(s({ id: 'a', lastAccessedAt: entry }))).toBe(entry);
    const wrote = Date.now() - 60_000;
    expect(lastActiveAt(s({ id: 'a', lastAccessedAt: entry, lastActivity: wrote }))).toBe(new Date(wrote).toISOString());
    const hooked = new Date(Date.now() - 1000).toISOString(); // newer than the write
    expect(
      lastActiveAt(s({ id: 'a', lastAccessedAt: entry, lastActivity: wrote, attention: { ...att('idle', true), updatedAt: hooked } })),
    ).toBe(hooked);
  });

  it('age sections: Now (wants you, working, or used today), This week, Older', () => {
    expect(ageBucket(s({ id: 'a', lastAccessedAt: minsAgo(60 * 24 * 30), attention: att('needs_input', false) }))).toBe('now');
    expect(ageBucket(s({ id: 'a', lastAccessedAt: minsAgo(60 * 5) }))).toBe('now');
    expect(ageBucket(s({ id: 'a', lastAccessedAt: minsAgo(60 * 24 * 3) }))).toBe('week');
    expect(ageBucket(s({ id: 'a', lastAccessedAt: minsAgo(60 * 24 * 10) }))).toBe('older');
    // Claude writing today makes an old entry "now" (it's the newest sign of life).
    expect(ageBucket(s({ id: 'a', lastAccessedAt: minsAgo(60 * 24 * 10), lastActivity: Date.now() - 3_600_000 }))).toBe('now');
  });

  it('buckets for the Sessions header and filter', () => {
    expect(statusBucket('needs_input')).toBe('needs');
    expect(statusBucket('done')).toBe('needs');
    expect(statusBucket('working')).toBe('working');
    expect(statusBucket('background')).toBe('working');
    expect(statusBucket('active')).toBe('working');
    expect(statusBucket('quiet')).toBe('idle');
    expect(statusBucket('open')).toBe('idle');
    expect(statusBucket('recent')).toBe('idle');
    expect(statusBucket('stale')).toBe('stale');
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
    // The worktree switched branch (Claude or you): its PR is on the branch checked out now.
    expect(
      prsForSession(s({ id: 'x', branch: 'tmp/check', target: 'api', onOtherBranch: [{ repo: 'api', branch: 'feat/x' }] }), prs).map(
        (p) => p.number,
      ),
    ).toEqual([1]);
    expect(prsForSession(s({ id: 'x', branch: 'tmp/check', target: 'api', onOtherBranch: [{ repo: 'api', branch: null }] }), prs)).toEqual(
      [],
    );
    // In a group, a repo's checked-out branch counts for that repo only: web on feat/x doesn't claim api's PR from feat/x.
    const group = s({ id: 'g', branch: 'feat/g', target: 'shop', isGroup: true, onOtherBranch: [{ repo: 'web', branch: 'feat/x' }] });
    expect(prsForSession(group, prs).map((p) => p.number)).toEqual([2]);
  });

  it("a row with its own repos matches PRs in them only — a repo added to it too, never the group's others", () => {
    const prs = [
      pr({ number: 1, branch: 'feat/x', repoAlias: 'api' }),
      pr({ number: 2, branch: 'feat/x', repoAlias: 'web' }),
      pr({ number: 3, branch: 'feat/x', repoAlias: 'docs' }),
    ];
    const folder = s({ id: 'x', branch: 'feat/x', target: 'shop', isGroup: true, repos: ['api', 'docs'] });
    expect(prsForSession(folder, prs, () => ['api', 'web']).map((p) => p.number)).toEqual([1, 3]);
    // Without `repos` (an older server): the group's configured members, as before.
    const old = s({ id: 'x', branch: 'feat/x', target: 'shop', isGroup: true });
    expect(prsForSession(old, prs, () => ['api', 'web']).map((p) => p.number)).toEqual([1, 2]);
    // A single repo's list is its target.
    expect(prsForSession(s({ id: 'x', branch: 'feat/x', target: 'api', repos: ['api'] }), prs).map((p) => p.number)).toEqual([1]);
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

  it('a session being archived says so: the Archiving icon and "archiving…", whatever its Claude was doing', () => {
    const sessions = [s({ id: 'feat/x', archiving: true, attention: att('needs_input', false) })];
    act(() => root.render(createElement(SessionRail, { sessions, activeSessionId: null, onSelect: () => {}, onNewWorktree: () => {} })));
    const row = container.querySelector('.wd-dash-rail-item')!;
    expect(row.querySelector('.wd-rail-dot-archiving')).not.toBeNull();
    expect(row.textContent).toContain('archiving…');
  });

  it('an archived session being restored is back in the rail at once, as Restoring; one that is not stays out', () => {
    const sessions = [s({ id: 'back', archivedAt: minsAgo(60), restoring: true }), s({ id: 'gone', archivedAt: minsAgo(60) })];
    act(() => root.render(createElement(SessionRail, { sessions, activeSessionId: null, onSelect: () => {}, onNewWorktree: () => {} })));
    const rows = container.querySelectorAll('.wd-dash-rail-item');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.wd-dash-rail-name')?.textContent).toBe('back');
    expect(rows[0].querySelector('.wd-rail-dot-restoring')).not.toBeNull();
    expect(rows[0].textContent).toContain('restoring…');
  });

  it('two lines a row, the same for every row: branch and time, then project and PRs; the rest is in its tooltip; hides archived', () => {
    const sessions = [
      s({
        id: 'feat/x',
        attention: att('needs_input', false, 'Claude needs your permission to use Bash'),
        diffStat: { added: 5, deleted: 1, files: 2 },
      }),
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
    // Not open, still two lines: its project on the left, its PR on the right —
    // never what its Claude said last (that's the session's header).
    expect(row.querySelector('.wd-dash-rail-summary')?.textContent).toBe('api');
    expect(row.querySelector('.wd-dash-rail-sub .wd-pr-chip')?.textContent).toBe('#42');
    expect(row.textContent).not.toContain('Claude needs your permission');
    expect(row.getAttribute('title')).toContain('Claude needs your permission to use Bash');
    // Its +/− lines are the Diff tab's, not the list's.
    expect(row.getAttribute('title')).not.toContain('+5');
    expect(row.querySelector('.wd-dash-rail-slot')?.className).toContain('wd-rail-slot-needs');
  });

  it('the open session reads the same as the others; a quiet one shows a relative time and no summary suffix', () => {
    act(() =>
      root.render(
        createElement(SessionRail, {
          // Created and entered at different times, so the rail's order doesn't hang on the clock ticking between them:
          // with no order of yours it's by when each was entered (stableSessionOrder), and two `minsAgo(100)` taken a
          // millisecond apart swapped them on a slow CI machine.
          sessions: [
            s({ id: 'q', createdAt: minsAgo(900), lastAccessedAt: minsAgo(90), attention: att('idle', true) }),
            s({ id: 'n', createdAt: minsAgo(1000), lastAccessedAt: minsAgo(100), attention: att('needs_input', false, 'Allow Bash?') }),
          ],
          activeSessionId: 'q',
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
    ({
      id,
      target,
      branch: id,
      isGroup: false,
      paths: [],
      createdAt: '',
      lastAccessedAt: new Date(now - daysAgo * day).toISOString(),
      ...extra,
    }) as never;

  it('keeps current sessions (recent, reporting a status, or live) and parks the rest as older', async () => {
    const { railSessions } = await import('../../src/web/src/state/session-display.js');
    const sessions = [
      // 50 old sessions of an alphabetically-first project…
      ...Array.from({ length: 50 }, (_, i) => mk(`old-${i}`, 'app-templates', 200 + i)),
      // …must not push the active work off the rail.
      mk('active', 'acme', 0),
      mk('old-but-blocked', 'acme', 90, { attention: { state: 'needs_input', seen: false, since: '', updatedAt: '', stale: false } }),
      mk('old-but-live', 'warp', 90, { ptyStatus: 'running' }),
      mk('archived', 'acme', 0, { archivedAt: '2026-09-01' }),
    ];
    const { current, older } = railSessions(sessions, now);
    expect(current.map((s: { id: string }) => s.id)).toEqual(['active', 'old-but-blocked', 'old-but-live']);
    expect(older).toHaveLength(50);
    expect([...current, ...older].some((s: { id: string }) => s.id === 'archived')).toBe(false);
  });
});

describe('statusHint', () => {
  it('explains activity-only statuses, and nothing for real ones', async () => {
    const { statusHint } = await import('../../src/web/src/state/session-display.js');
    for (const k of ['active', 'open', 'recent', 'stale'] as const) expect(statusHint(k)).toMatch(/hooks/);
    for (const k of ['needs_input', 'done', 'working', 'quiet'] as const) expect(statusHint(k)).toBeUndefined();
  });
});

describe('agentName / agentCan: the session’s agent, and what work can do with it', () => {
  const echo = { id: 'echo', name: 'Echo', can: { read: true, hooks: false, live: false, answer: false } };
  it('names it and asks its capabilities', () => {
    expect(agentName({ agent: echo })).toBe('Echo');
    expect(agentCan({ agent: echo }, 'read')).toBe(true);
    expect(agentCan({ agent: echo }, 'answer')).toBe(false);
  });
  it('a row from a server before agents were named: Claude, everything as it was', () => {
    expect(agentName({})).toBe('Claude');
    expect(agentCan({}, 'answer')).toBe(true);
  });
});
