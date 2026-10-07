import { describe, expect, it } from 'vitest';
import type { OpenReviewThread, PrReply, SessionCi } from '../../src/core/api-types.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import { orderedSections, prSections, prTabButton } from '../../src/web/src/state/pr-tab.js';

const shipPr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  url: `https://gh/${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  checks: 'pass',
  headSha: 'abc',
  ...over,
});
const listed = (number: number, over: Partial<PrInfo> = {}): PrInfo => ({
  number,
  title: `PR ${number}`,
  branch: 'feat/x',
  url: `https://gh/${number}`,
  isDraft: false,
  checksStatus: 'SUCCESS',
  reviewDecision: 'REVIEW_REQUIRED',
  myReview: 'NONE',
  isMine: true,
  repoAlias: 'frontend',
  ...over,
});
const thread = (repo: string, prNumber: number, id: string): OpenReviewThread => ({
  threadId: id,
  repo,
  prNumber,
  url: 'u',
  where: 'a.ts:1',
  reviewer: 'copilot',
  excerpt: 'x',
  trusted: true,
});

// A group: backend's PR merged, frontend's open with failing checks, and a second
// frontend PR from the same branch (into another base) only the PR list knows.
const ci = {
  checkedAt: '',
  repos: [
    { name: 'backend', done: true, pr: shipPr(3509, { state: 'MERGED', mergedAt: '2026-10-05T08:40:20Z' }) },
    { name: 'frontend', done: false, pr: shipPr(1927, { checks: 'fail', failing: [{ name: 'build', url: 'https://ci/1' }] }) },
  ],
} as unknown as SessionCi;
const list = [listed(1927, { title: 'Unassign in Adyen' }), listed(1990, { title: 'Same branch, into main', checksStatus: 'PENDING' })];

describe('prSections', () => {
  it("one section per PR: each repo's from the PR watch, and a second one from the branch from the PR list", () => {
    const s = prSections(ci, list);
    expect(s.map((x) => [x.repo, x.number, x.kind, x.title, x.fromListOnly])).toEqual([
      ['backend', 3509, 'merged', null, false],
      ['frontend', 1927, 'checks_failing', 'Unassign in Adyen', false],
      ['frontend', 1990, 'in_review', 'Same branch, into main', true],
    ]);
    expect(s[1].failing).toEqual([{ name: 'build', url: 'https://ci/1' }]);
  });

  it('what wants you first, then open ones, then merged; threads and drafts go to their own PR', () => {
    const waiting = [thread('frontend', 1990, 'T1'), thread('frontend', 1990, 'T2')];
    const replies = [{ ...thread('frontend', 1927, 'T3'), status: 'draft', draft: 'Fixed', sentAt: '' } as PrReply];
    const o = orderedSections(prSections(ci, list), waiting, replies);
    expect(o.map((x) => [x.section.number, x.wants, x.waiting.length, x.replies.length])).toEqual([
      [1927, 2, 0, 1], // a draft to post + failing checks
      [1990, 2, 2, 0], // two threads with no reply
      [3509, 0, 0, 0], // merged: last
    ]);
  });
});

describe('prTabButton', () => {
  const stage = (prs: Array<[number, string]>) => ({
    kind: 'in_review' as const,
    text: '',
    key: '',
    prs: prs.map(([number, kind]) => ({ repo: 'frontend', number, url: `https://gh/${number}`, kind: kind as never })),
  });

  it('one PR: "PR · #212 waiting for review"; several: "PRs · 2" — the PR list adds a second PR from the branch', () => {
    expect(prTabButton({ prStage: stage([[212, 'in_review']]) }, [])).toEqual({ label: 'PR', meta: '#212 waiting for review', badge: 0 });
    expect(prTabButton({ prStage: stage([[212, 'in_review']]) }, [listed(212), listed(300)])).toEqual({
      label: 'PRs',
      meta: '2',
      badge: 0,
    });
  });

  it('badge: open threads, and each PR with failing checks or a conflict', () => {
    expect(
      prTabButton(
        {
          openReviewThreads: 3,
          prStage: stage([
            [1, 'checks_failing'],
            [2, 'conflict'],
          ]),
        },
        [],
      )!.badge,
    ).toBe(5);
  });

  it('no PR and nothing about one: no tab; threads alone still make one', () => {
    expect(prTabButton({}, [])).toBeNull();
    expect(prTabButton({ openReviewThreads: 1 }, [])).toEqual({ label: 'PR', badge: 1 });
  });
});

describe('a PR only the list knows', () => {
  it("reads the PR watch's way (stageOfPr): approved and green is ready to merge; pending and waiting for review is waiting for review", () => {
    const one = (p: Partial<PrInfo>) => prSections({ checkedAt: '', repos: [] } as unknown as SessionCi, [listed(5, p)])[0].kind;
    expect(one({ reviewDecision: 'APPROVED', checksStatus: 'SUCCESS' })).toBe('ready');
    expect(one({ reviewDecision: 'REVIEW_REQUIRED', checksStatus: 'PENDING' })).toBe('in_review');
    expect(one({ conflicting: true })).toBe('conflict');
  });
});
