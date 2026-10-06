import { describe, expect, it } from 'vitest';
import {
  cleanStageRef,
  createStageTracker,
  prStageOf,
  prsBeyondStage,
  stageNews,
  stageOfPr,
  stageWaiting,
  stageWantsYou,
  STAGE_WANTS_YOU,
  type StagePr,
} from '../../../src/core/pr/pr-stage.js';
import { inboxRank, prWantsYou, PR_STAGES_WANTING, wantsYou } from '../../../src/core/status/attention.js';
import { displayStatus } from '../../../src/core/sessions/session-view.js';
import { prStageWire, stageSeenKey } from '../../../src/core/sessions/session-wire.js';
import { snoozeActive, snoozeFor, statusKey } from '../../../src/core/rail/snooze.js';

const pr = (over: Partial<StagePr> = {}): StagePr => ({
  number: 212,
  url: 'https://github.com/o/api/pull/212',
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'BLOCKED',
  checks: 'pass',
  headSha: 'abc',
  reviewDecision: 'REVIEW_REQUIRED',
  ...over,
});

describe('stageOfPr', () => {
  it('waiting on reviewers, then approved: ready only when checks pass and nothing blocks the merge', () => {
    expect(stageOfPr(pr())).toBe('in_review');
    expect(stageOfPr(pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }))).toBe('ready');
    expect(stageOfPr(pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'HAS_HOOKS', checks: 'none' }))).toBe('ready');
    expect(stageOfPr(pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'BEHIND' }))).toBe('approved');
    expect(stageOfPr(pr({ reviewDecision: 'APPROVED', checks: 'pending', mergeStateStatus: 'CLEAN' }))).toBe('checks_running');
  });

  it('a conflict or failing checks outweigh any review; a draft is still yours', () => {
    expect(stageOfPr(pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'DIRTY' }))).toBe('conflict');
    expect(stageOfPr(pr({ reviewDecision: 'APPROVED', checks: 'fail' }))).toBe('checks_failing');
    expect(stageOfPr(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('changes');
    expect(stageOfPr(pr({ isDraft: true, checks: 'fail' }))).toBe('draft');
    expect(stageOfPr(pr({ state: 'MERGED' }))).toBe('merged');
  });

  it('a repo that requires no review ("" decision): checks running, then in review', () => {
    expect(stageOfPr(pr({ reviewDecision: '', checks: 'pending' }))).toBe('checks_running');
    expect(stageOfPr(pr({ reviewDecision: '' }))).toBe('in_review');
  });
});

describe('prStageOf', () => {
  it('one line per session, a key that moves with the head', () => {
    const st = prStageOf([{ name: 'api', pr: pr() }])!;
    expect(st).toMatchObject({ kind: 'in_review', text: 'PR #212 · waiting for review', prs: [{ repo: 'api', number: 212 }] });
    expect(prStageOf([{ name: 'api', pr: pr({ headSha: 'def' }) }])!.key).not.toBe(st.key);
    expect(prStageOf([{ name: 'api', pr: pr({ isDraft: true }) }])!.text).toBe('Draft PR #212');
    expect(prStageOf([{ name: 'api', pr: null }])).toBeNull();
  });

  it('a group shows its most pressing open PR, and is ready only when every open one is', () => {
    const ready = pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' });
    const st = prStageOf([
      { name: 'backend', pr: { ...ready, number: 12 } },
      { name: 'frontend', pr: { ...pr(), number: 8 } },
    ])!;
    expect(st.kind).toBe('in_review');
    expect(st.text).toBe('PRs backend #12, frontend #8 · waiting for review');
    // Each PR keeps its own stage: the dashboard shows (and links) them one by one.
    expect(st.prs.map((p) => `${p.repo} #${p.number} ${p.kind}`)).toEqual(['backend #12 ready', 'frontend #8 in_review']);
    expect(
      prStageOf([
        { name: 'backend', pr: { ...ready, number: 12 } },
        { name: 'frontend', pr: { ...ready, number: 8 } },
      ])!.kind,
    ).toBe('ready');
    // A merged repo is done: the open one says where the session stands — and the
    // merged one is still listed, after it, so its pill shows the group had (and merged) it.
    const partly = prStageOf([
      { name: 'backend', pr: { ...pr(), number: 3509, state: 'MERGED' } },
      { name: 'frontend', pr: { ...ready, number: 8 } },
    ])!;
    expect(partly).toMatchObject({ kind: 'ready', text: 'PR #8 · approved, ready to merge' });
    expect(partly.prs.map((p) => `${p.repo} #${p.number} ${p.kind}`)).toEqual(['frontend #8 ready', 'backend #3509 merged']);
    expect(partly.key).not.toContain('backend');
    expect(prStageOf([{ name: 'api', pr: pr({ state: 'MERGED' }) }])!.kind).toBe('merged');
  });
});

describe('what a stage does to the Inbox', () => {
  const ready = prStageOf([{ name: 'api', pr: pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }) }])!;
  const waiting = prStageOf([{ name: 'api', pr: pr() }])!;
  const quiet = { state: 'idle' as const, seen: true, since: '2026-10-01T10:00:00Z' };

  it('the stages that bring it back are the same in attention.ts (which imports nothing)', () => {
    expect([...PR_STAGES_WANTING].sort()).toEqual([...STAGE_WANTS_YOU].sort());
  });

  it('ready to merge wants you until you have seen it there; in review waits, out of the Inbox', () => {
    expect(stageWantsYou(ready)).toBe(true);
    expect(stageWantsYou({ ...ready, seen: true })).toBe(false);
    expect(stageWaiting(waiting)).toBe(true);
    expect(inboxRank({ attention: quiet, prStage: ready })).toBe(2);
    expect(wantsYou({ attention: quiet, prStage: { ...ready, seen: true } })).toBe(false);
    expect(wantsYou({ attention: quiet, prStage: waiting })).toBe(false);
    // Its Claude at work comes first: it shows working.
    expect(inboxRank({ attention: { ...quiet, state: 'working' }, prStage: ready })).toBe(3);
    expect(prWantsYou({ prStage: null })).toBe(false);
  });

  it('the status word: Pull request while it wants you, In review while it waits; review comments and a finished turn come first', () => {
    const row = { lastAccessedAt: '2026-10-01T10:00:00Z', attention: { ...quiet, updatedAt: quiet.since, stale: false } };
    expect(displayStatus({ ...row, prStage: ready })).toBe('pr');
    expect(displayStatus({ ...row, prStage: waiting })).toBe('in_review');
    expect(displayStatus({ ...row, prStage: { ...ready, seen: true } })).toBe('quiet');
    expect(displayStatus({ ...row, prStage: ready, openReviewThreads: 1 })).toBe('review');
    expect(displayStatus({ ...row, attention: { ...row.attention, seen: false }, prStage: waiting })).toBe('done');
  });

  it('prStageWire reads "seen" only for a stage that wants you, by its key', () => {
    const ci = { repos: [{ name: 'api', pr: pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }) }] };
    const asked: string[] = [];
    expect(prStageWire(ci, (k) => (asked.push(k), true))).toMatchObject({ kind: 'ready', seen: true });
    expect(asked).toEqual([stageSeenKey(ready.key)]);
    expect(prStageWire(ci, () => false)!.seen).toBeUndefined();
    asked.length = 0;
    prStageWire({ repos: [{ name: 'api', pr: pr() }] }, (k) => (asked.push(k), true));
    expect(asked).toEqual([]);
    expect(prStageWire(null, () => true)).toBeNull();
  });

  it('a snooze "until it changes" ends when the PR moves on, and one taken without a stage still holds', () => {
    const subject = { attention: quiet, openReviewThreads: 0, prStage: ready };
    const z = snoozeFor('change', subject);
    expect(snoozeActive(z, subject)).toBe(true);
    const pushed = prStageOf([{ name: 'api', pr: pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', headSha: 'new' }) }])!;
    expect(snoozeActive(z, { ...subject, prStage: pushed })).toBe(false);
    // Waiting stages don't enter the key: a snooze from before stages existed reads the same.
    expect(statusKey({ attention: quiet, prStage: waiting })).toBe(statusKey({ attention: quiet }));
  });
});

describe('news from a check', () => {
  const ready = prStageOf([{ name: 'api', pr: pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }) }])!;
  const waiting = prStageOf([{ name: 'api', pr: pr() }])!;

  it('the first sight after a start is only shown; moving into a stage that wants you is told', () => {
    expect(stageNews(undefined, ready)).toBe('changed');
    expect(stageNews(waiting.key, ready)).toBe('notify');
    expect(stageNews(ready.key, ready)).toBe('none');
    expect(stageNews(ready.key, waiting)).toBe('changed');
    expect(stageNews(ready.key, null)).toBe('changed');
    expect(stageNews('', null)).toBe('none');
  });

  it('the tracker remembers per session', () => {
    const news = createStageTracker();
    expect(news('a', waiting)).toBe('changed');
    expect(news('b', ready)).toBe('changed');
    expect(news('a', ready)).toBe('notify');
    expect(news('a', ready)).toBe('none');
  });

  it('cleanStageRef takes only a known kind and a key', () => {
    expect(cleanStageRef({ kind: 'ready', key: 'k' })).toEqual({ kind: 'ready', key: 'k' });
    expect(cleanStageRef({ kind: 'toString', key: 'k' })).toBeNull();
    expect(cleanStageRef({ kind: 'ready' })).toBeNull();
    expect(cleanStageRef('ready')).toBeNull();
  });
});

describe('prsBeyondStage', () => {
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  it("a second PR from the same branch, which the watch doesn't hold, is left over; no stage leaves them all", () => {
    const stage = { prs: [{ repo: 'api', number: 3530, url: url(3530), kind: 'in_review' as const }] };
    const listed = [{ url: url(3529) }, { url: url(3530) }];
    expect(prsBeyondStage(stage, listed)).toEqual([{ url: url(3529) }]);
    expect(prsBeyondStage(undefined, listed)).toEqual(listed);
  });
});
