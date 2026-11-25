import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import { displayStatus } from '../../src/web/src/state/session-display.js';
import { RAIL_PR_MARKS, railCard, railName, railPrMarks, railPrsText, railStatus, railTime } from '../../src/web/src/state/rail-row.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const session = (extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: 's',
    target: 'api',
    branch: 'feat/stored-cards',
    isGroup: false,
    paths: ['/wt/s'],
    createdAt: ago(600),
    lastAccessedAt: ago(90),
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
    ...extra,
  }) as SessionSummary;
const attention = (state: 'needs_input' | 'working' | 'idle', sinceMin: number, extra: object = {}) =>
  ({
    state,
    seen: true,
    since: ago(sinceMin),
    updatedAt: ago(sinceMin),
    stale: false,
    ...extra,
  }) as SessionSummary['attention'];
const stage = (prs: Array<{ repo: string; number: number; kind: string }>, kind = prs[0].kind) =>
  ({
    kind,
    text: `PR #${prs[0].number} · ${kind}`,
    key: 'k',
    prs: prs.map((p) => ({ ...p, url: `https://github.com/o/${p.repo}/pull/${p.number}` })),
  }) as SessionSummary['prStage'];
const listed = (n: number, isDraft = false, repoAlias = 'api'): PrInfo =>
  ({
    number: n,
    title: `PR ${n}`,
    branch: 'feat/stored-cards',
    url: `https://github.com/o/${repoAlias}/pull/${n}`,
    isDraft,
    checksStatus: 'PENDING',
    reviewDecision: 'REVIEW_REQUIRED',
    myReview: 'NONE',
    isMine: true,
    repoAlias,
  }) as PrInfo;

describe('railName: the name, a branch’s type prefix apart', () => {
  it('a branch: the part up to and including the first / is the prefix, the slug the rest', () => {
    expect(railName(session())).toEqual({ named: false, prefix: 'feat/', rest: 'stored-cards' });
    expect(railName(session({ branch: 'fix/api/retries' }))).toEqual({ named: false, prefix: 'fix/', rest: 'api/retries' });
  });

  it('no prefix to split: a plain branch, a slash at either end, no branch (the project then)', () => {
    expect(railName(session({ branch: 'main' }))).toEqual({ named: false, prefix: '', rest: 'main' });
    expect(railName(session({ branch: '/x' }))).toEqual({ named: false, prefix: '', rest: '/x' });
    expect(railName(session({ branch: 'feat/' }))).toEqual({ named: false, prefix: '', rest: 'feat/' });
    expect(railName(session({ branch: '' }))).toEqual({ named: false, prefix: '', rest: 'api' });
  });

  it('a name you gave is never split; an automatic title is not a name you gave', () => {
    expect(railName(session({ title: 'Docs/refunds', titleIsYours: true }))).toEqual({ named: true, prefix: '', rest: 'Docs/refunds' });
    expect(railName(session({ title: 'Stored cards', titleIsYours: false }))).toEqual({
      named: false,
      prefix: 'feat/',
      rest: 'stored-cards',
    });
  });
});

describe('railTime: line 1’s slot is always a time', () => {
  const time = (s: SessionSummary) => railTime(s, displayStatus(s, NOW), NOW);

  it('while its agent asks or works: how long in that state, in that state’s colour', () => {
    expect(time(session({ attention: attention('needs_input', 5) }))).toEqual({ text: '5m', cls: 'wd-rail-slot-needs wd-mono' });
    expect(time(session({ attention: attention('working', 12) }))).toEqual({ text: '12m', cls: 'wd-rail-slot-working wd-mono' });
    expect(time(session({ attention: attention('working', 3, { background: { what: null } }) }))).toEqual({
      text: '3m',
      cls: 'wd-rail-slot-background wd-mono',
    });
  });

  it('else when it was last used, quiet', () => {
    expect(time(session())).toEqual({ text: '1h', cls: 'wd-mono' });
    expect(time(session({ attention: attention('idle', 30) }))).toEqual({ text: '30m', cls: 'wd-mono' });
  });

  it('never a badge: what you owe, snoozed and in review are line 2’s; a snoozed row’s time is quiet', () => {
    expect(time(session({ openReviewThreads: 2 }))).toEqual({ text: '1h', cls: 'wd-mono' });
    expect(time(session({ prStage: stage([{ repo: 'api', number: 7, kind: 'in_review' }]) }))).toEqual({ text: '1h', cls: 'wd-mono' });
    expect(time(session({ snoozed: { until: null }, attention: attention('working', 4) }))).toEqual({ text: '4m', cls: 'wd-mono' });
  });

  it('archiving… and restoring… while that happens, whatever its agent was doing', () => {
    expect(time(session({ archiving: true, attention: attention('needs_input', 5) }))).toEqual({
      text: 'archiving…',
      cls: 'wd-rail-slot-archiving',
    });
    expect(time(session({ restoring: true, archivedAt: ago(60) }))).toEqual({ text: 'restoring…', cls: 'wd-rail-slot-archiving' });
  });
});

describe('railStatus: line 2’s one status', () => {
  const inReview = stage([{ repo: 'api', number: 7, kind: 'in_review' }]);

  it('snoozed wins over what you owe, which stays in its hover', () => {
    expect(railStatus(session({ openReviewThreads: 2, replyDrafts: 1, snoozed: { until: null }, prStage: inReview }))).toEqual({
      kind: 'snoozed',
      text: 'snoozed',
      title: 'Snoozed until it changes\nNeeds you: 1 reply to post · 2 review threads with no answer',
    });
  });

  it('what you owe, with what it is about', () => {
    const s = railStatus(session({ openReviewThreads: 2, replyDrafts: 1, prStage: inReview }));
    expect(s).toMatchObject({ kind: 'owed', text: '1 reply +1' });
    expect(s?.title).toBe('Needs you: 1 reply to post · 2 review threads with no answer');
    expect(railStatus(session({ prStage: stage([{ repo: 'api', number: 7, kind: 'ready' }]) }))).toMatchObject({
      kind: 'owed',
      text: 'merge',
    });
  });

  it('snoozed alone (until when, on hover); else in review (the PR’s line), else nothing', () => {
    expect(railStatus(session({ snoozed: { until: null }, prStage: inReview }))).toEqual({
      kind: 'snoozed',
      text: 'snoozed',
      title: 'Snoozed until it changes',
    });
    expect(railStatus(session({ prStage: inReview }))).toEqual({ kind: 'review', text: 'in review', title: 'PR #7 · in_review' });
    expect(railStatus(session())).toBeNull();
    expect(railStatus(session({ attention: attention('working', 2) }))).toBeNull();
  });
});

describe('railPrMarks: a dot per PR, at most five, then +N', () => {
  it('the PR watch’s first, each with its stage’s tone; then the list’s the watch doesn’t hold (a draft a ring)', () => {
    const s = session({
      prStage: stage([
        { repo: 'api', number: 3530, kind: 'in_review' },
        { repo: 'web', number: 12, kind: 'ready' },
        { repo: 'web', number: 9, kind: 'merged' },
        { repo: 'api', number: 3600, kind: 'conflict' },
      ]),
    });
    const { shown, more } = railPrMarks(s, [listed(3530), listed(3529, true)]);
    expect(shown.map((m) => [m.label, m.tone])).toEqual([
      ['api #3530 · waiting for review', 'plain'],
      ['web #12 · ready to merge', 'good'],
      ['web #9 · merged', 'merged'],
      ['api #3600 · merge conflict', 'bad'],
      ['api #3529 · draft', 'draft'],
    ]);
    expect(more).toEqual([]);
    expect(shown[1].url).toBe('https://github.com/o/web/pull/12');
  });

  it('before the watch has looked: the list, open or draft', () => {
    const { shown } = railPrMarks(session(), [listed(41), listed(42, true)]);
    expect(shown.map((m) => [m.label, m.tone])).toEqual([
      ['api #41 · open', 'plain'],
      ['api #42 · draft', 'draft'],
    ]);
  });

  it('seven PRs: five dots and two counted; the tooltip still names every one', () => {
    const marks = railPrMarks(
      session(),
      Array.from({ length: 7 }, (_, i) => listed(100 + i)),
    );
    expect(RAIL_PR_MARKS).toBe(5);
    expect(marks.shown).toHaveLength(5);
    expect(marks.more.map((m) => m.label)).toEqual(['api #105 · open', 'api #106 · open']);
    expect(railPrsText(marks)).toBe(
      'PRs api #100 · open, api #101 · open, api #102 · open, api #103 · open, api #104 · open, api #105 · open, api #106 · open',
    );
  });

  it('none: nothing to draw or say; one: “PR …”', () => {
    expect(railPrMarks(session(), [])).toEqual({ shown: [], more: [] });
    expect(railPrsText({ shown: [], more: [] })).toBe('');
    expect(railPrsText(railPrMarks(session(), [listed(8)]))).toBe('PR api #8 · open');
  });
});

describe('railCard: what a Project row’s card says', () => {
  it('the name whole, the project and branch, the state with its agent’s last line', () => {
    const s = session({ attention: attention('working', 4, { summary: 'running the tests' }) });
    const card = railCard(s, displayStatus(s, NOW), []);
    expect(card.name).toBe('feat/stored-cards');
    expect(card.where).toBe('api · feat/stored-cards');
    expect(card.state).toBe('Working — running the tests');
    expect(card.prs).toEqual([]);
  });

  it('a name you gave: the name, and the branch still said beside the project', () => {
    const s = session({ title: 'Stored cards', titleIsYours: true });
    const card = railCard(s, displayStatus(s, NOW), []);
    expect(card.name).toBe('Stored cards');
    expect(card.where).toBe('api · feat/stored-cards');
  });

  it('every PR, not five: its title from the list, its stage from the watch; one only the watch knows has no title', () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ repo: 'api', number: n, kind: 'in_review' }));
    const s = session({ prStage: stage(many) });
    const card = railCard(s, displayStatus(s, NOW), [listed(2), listed(99, true)]);
    expect(card.prs).toHaveLength(8);
    expect(card.prs[0]).toMatchObject({ label: 'api #1', title: null, stage: 'waiting for review', tone: 'plain' });
    expect(card.prs[1]).toMatchObject({ label: 'api #2', title: listed(2).title });
    expect(card.prs[7]).toMatchObject({ label: 'api #99', title: listed(99).title, stage: 'draft', tone: 'draft' });
  });
});
