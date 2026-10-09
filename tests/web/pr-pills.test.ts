// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';
import { PrStageChip, RailPrPills } from '../../src/web/src/components/Dashboard/SessionBits.js';

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

const url = (n: number) => `https://github.com/acme/acme-backend/pull/${n}`;
const listed = (n: number, isDraft = false): PrInfo => ({
  number: n,
  title: `PR ${n}`,
  branch: 'fix/hosted-kortalan-duration',
  url: url(n),
  isDraft,
  checksStatus: 'PENDING',
  reviewDecision: 'REVIEW_REQUIRED',
  myReview: 'NONE',
  isMine: true,
  repoAlias: 'acme-backend',
});
// One branch, two PRs (into main and into dev): the PR watch holds only #3530.
const session = {
  id: 's1',
  prStage: {
    kind: 'in_review',
    text: 'PR #3530 · waiting for review',
    prs: [{ repo: 'acme-backend', number: 3530, url: url(3530), kind: 'in_review' }],
    key: 'k',
  },
} as unknown as SessionSummary;
const pills = () => [...container.querySelectorAll('.wd-pr-chip')].map((e) => e.textContent);

describe('PR pills with two PRs from one branch', () => {
  it("the rail shows both: the watch's with its stage, the other from the PR list", () => {
    act(() => root.render(createElement(RailPrPills, { session, prs: [listed(3529, true), listed(3530)] })));
    expect(pills()).toEqual(['#3530', '#3529']);
    expect(container.querySelectorAll('.wd-pr-chip-draft')).toHaveLength(1);
  });

  it('the session header shows both, each linked to its PR', () => {
    act(() => root.render(createElement(PrStageChip, { session, prs: [listed(3529), listed(3530)] })));
    expect(pills()).toEqual(['#3530 · waiting for review', '#3529']);
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([url(3530), url(3529)]);
  });

  it('before the watch has looked, the rail shows the list', () => {
    act(() => root.render(createElement(RailPrPills, { session: { id: 's1' } as SessionSummary, prs: [listed(3529), listed(3530)] })));
    expect(pills()).toEqual(['#3529', '#3530']);
  });
});

describe('a merged PR beside an open one (a group whose backend merged)', () => {
  const group = {
    ...session,
    isGroup: true,
    prStage: {
      kind: 'in_review',
      text: 'PR #1927 · waiting for review',
      key: 'k',
      prs: [
        { repo: 'frontend', number: 1927, url: url(1927), kind: 'in_review' },
        { repo: 'backend', number: 3509, url: url(3509), kind: 'merged' },
      ],
    },
  } as unknown as typeof session;

  it('both pills show, the merged one in its own colour — in the rail and the header', () => {
    act(() => root.render(createElement(RailPrPills, { session: group, prs: [] })));
    expect(pills()).toEqual(['#1927', '#3509']);
    expect(container.querySelectorAll('.wd-pr-stage-merged')).toHaveLength(1);
    act(() => root.render(createElement(PrStageChip, { session: group, prs: [] })));
    expect(pills()).toEqual(['frontend #1927 · waiting for review', 'backend #3509 · merged']);
    expect(container.querySelector('.wd-pr-stage-merged')!.textContent).toBe('backend #3509 · merged');
  });
});
