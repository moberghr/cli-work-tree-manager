// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { demoReview, demoReviewFiles } from '../../src/server/demo/demo-reviews.js';
import { summaryOf } from '../../src/core/review/review-build.js';
import type { PrReviewWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  fetchReviews: vi.fn(),
  fetchReview: vi.fn(),
  fetchReviewDiff: vi.fn(),
  prepareReview: vi.fn(),
  submitReview: vi.fn(),
  addReviewDraft: vi.fn(),
  discardReviewDraft: vi.fn(),
  fetchReviewSettings: vi.fn(),
  saveReviewMode: vi.fn(),
  settleReviewInDoubt: vi.fn(),
  clearReviewDropped: vi.fn(),
  fixReviewMyself: vi.fn(),
}));
vi.mock('../../src/web/src/api/panes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/panes.js')>()),
  ...api,
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => undefined }));
const { ReviewsTab } = await import('../../src/web/src/components/Dashboard/tabs/ReviewsTab.js');

let container: HTMLDivElement;
let root: Root;
let review: PrReviewWire;
const flush = async () => {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  review = demoReview(new Date('2026-11-02T10:00:00Z'));
  for (const f of Object.values(api)) f.mockReset();
  const azurePr = {
    ...summaryOf(review),
    repo: 'payments',
    number: 57,
    title: 'Retry declined payments',
    host: 'azure',
    at: '2026-11-01T10:00:00Z',
  };
  api.fetchReviews.mockResolvedValue({ reviews: [summaryOf(review), azurePr], today: 1, maxPerDay: null });
  api.fetchReview.mockResolvedValue(review);
  api.fetchReviewDiff.mockResolvedValue({ files: demoReviewFiles() });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ReviewsTab', () => {
  it('lists the reviews by repo (with the host where it isn’t GitHub), and None as one list; the review names its repo', async () => {
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const heads = [...container.querySelectorAll('.wd-reviews-group-head')].map((h) => h.textContent);
    expect(heads).toEqual(['api · 1', 'payments · 1 · Azure DevOps']);
    expect(container.textContent).toContain('1 prepared today');
    expect(container.querySelector('.wd-review-header h2')!.textContent).toContain('api #231');
    act(() => button('None').click());
    expect(container.querySelectorAll('.wd-reviews-group-head')).toHaveLength(0);
    expect(container.querySelector('.wd-reviews-list')!.textContent).toContain('payments #57');
    expect(container.querySelector('.wd-resize-divider')).not.toBeNull();
  });

  it("the tree is the review's order: stories (with their tests) first, then kinds, generated and mechanical folded", async () => {
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const tree = container.querySelector('.wd-review-tree')!;
    const heads = [...tree.querySelectorAll('.wd-review-tree-head')].map((b) => b.textContent);
    expect(heads).toEqual([
      '▾ Refunds an order: handler and validator',
      '▾ Rounding half away from zero',
      '▾ Schema · 1',
      '▾ API surface · 1',
      '▾ Wiring · 1',
      '▾ Dependencies, build & CI · 1',
      '▸ Mechanical · 1',
      '▸ Generated · 3',
    ]);
    expect(tree.textContent).toContain('🧪 RefundHandlerTests.cs');
    // The diff follows the tree: each story's reasoning above its files; folded kinds aren't drawn until opened.
    const pane = container.querySelector('.wd-review-diff-pane')!;
    expect(pane.textContent).toContain('Why ranked here: moves money');
    expect(pane.textContent!.indexOf('RefundHandler.cs')).toBeLessThan(pane.textContent!.indexOf('Rounding.cs'));
    expect(pane.textContent).not.toContain('ShopDbModelSnapshot.cs');
    act(() => button('Generated · 3').click());
    expect(container.querySelector('.wd-review-diff-pane')!.textContent).toContain('ShopDbModelSnapshot.cs');
  });

  it('the drafts sit on their lines in the diff; Submit sends them as one review with the verdict and summary', async () => {
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const pane = container.querySelector('.wd-review-diff-pane')!;
    expect(pane.textContent).toContain('Two refunds at once both read the old');
    // A draft of the review: no reply or resolve, only Delete (it goes out with the review, or not at all).
    const draft = pane.querySelector('.wd-status-draft')!;
    expect([...draft.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Delete']);
    expect(container.querySelector('.wd-review-submit')!.textContent).toContain('2 comments on the diff');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Verdict"]')!;
    await act(async () => {
      select.value = 'request-changes';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    api.submitReview.mockResolvedValue({
      ...review,
      drafts: review.drafts.map((d) => ({ ...d, state: 'posted' })),
      submitted: { at: '2026-11-02T11:00:00Z', event: 'request-changes' },
    });
    await act(async () => button('Submit review on GitHub').click());
    expect(api.submitReview).toHaveBeenCalledWith('api', 231, {
      event: 'request-changes',
      body: '',
      drafts: review.drafts.map((d) => ({ id: d.id, body: d.body })),
    });
    expect(container.textContent).toContain('you submitted changes requested');
  });

  it('the tests strip is one line that unfolds to the breakdown', async () => {
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const strip = container.querySelector('.wd-review-tests-strip')!;
    expect(strip.textContent).toContain('Tests: 2 added · 0 changed · 0 removed · 0 skipped');
    expect(strip.textContent).toContain('the schema changes with unit tests only');
    expect(strip.textContent).not.toContain('asserts:');
    act(() => button('Tests:').click());
    expect(container.querySelector('.wd-review-tests-strip')!.textContent).toContain('asserts: nothing yet: its body is empty (AI)');
  });

  it('a waiting review says why, and Prepare it now prepares it', async () => {
    const waiting: PrReviewWire = {
      ...review,
      status: 'waiting',
      why: '4812 changed lines: over the size limit (3000), so it waits for your click',
    };
    api.fetchReviews.mockResolvedValue({ reviews: [summaryOf(waiting)], today: 0, maxPerDay: null });
    api.fetchReview.mockResolvedValue(waiting);
    api.prepareReview.mockResolvedValue(review);
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    expect(container.textContent).toContain('over the size limit (3000)');
    expect(container.querySelector('.wd-review-submit')).toBeNull();
    await act(async () => button('Prepare it now').click());
    await flush();
    expect(api.prepareReview).toHaveBeenCalledWith('api', 231);
    expect(container.querySelector('.wd-review-tree')).not.toBeNull();
  });

  it('settings: each project with its mode and where it comes from; a change is saved', async () => {
    api.fetchReviewSettings.mockResolvedValue({
      projects: [
        { name: 'api', kind: 'repo', mode: 'asked', from: 'group', group: 'shop' },
        { name: 'shop', kind: 'group', mode: 'asked', from: 'repo' },
      ],
      maxPerDay: null,
      maxLines: 3000,
    });
    api.saveReviewMode.mockImplementation(async () => api.fetchReviewSettings());
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    act(() => button('Which PRs').click());
    await flush();
    expect(container.textContent).toContain('(from the group shop)');
    expect(container.textContent).not.toContain('a day');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Reviews for api"]')!;
    await act(async () => {
      select.value = 'off';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.saveReviewMode).toHaveBeenCalledWith('api', 'off');
  });
  it('a submit that stopped part way: the error is said and the review shows what went out (partly submitted)', async () => {
    const { ReviewSubmitError } = await import('../../src/web/src/api/panes.js');
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const partly: PrReviewWire = {
      ...review,
      drafts: review.drafts.map((d, i) => (i === 0 ? { ...d, state: 'posted' } : d)),
      submitted: { at: '2026-11-02T11:00:00Z', event: 'comment', partial: true },
    };
    api.submitReview.mockRejectedValue(new ReviewSubmitError('src/x.cs:7: TF400898', partly));
    await act(async () => button('Submit review on GitHub').click());
    await flush();
    expect(container.querySelector('.wd-review-submit')!.textContent).toContain('src/x.cs:7: TF400898');
    expect(container.querySelector('.wd-review-submit')!.textContent).toContain('1 comment on the diff');
    expect(container.textContent).toContain('only part of it went out');
  });

  it('a submit in doubt: said, Submit held, and you say whether it went', async () => {
    const doubt: PrReviewWire = {
      ...review,
      inDoubt: { at: '2026-11-02T10:00:00Z', event: 'comment', drafts: [{ id: 'd1', body: 'x' }], summary: 'S', error: 'gh timed out' },
    };
    api.fetchReview.mockResolvedValue(doubt);
    api.settleReviewInDoubt.mockResolvedValue({
      ...review,
      drafts: review.drafts.map((d, i) => (i === 0 ? { ...d, state: 'posted' } : d)),
    });
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const banner = container.querySelector('.wd-review-in-doubt')!;
    expect(banner.textContent).toContain('may have gone out (gh timed out): 1 comment and the summary');
    expect(button('Submit review on GitHub').disabled).toBe(true);
    await act(async () => button('It went out').click());
    await flush();
    expect(api.settleReviewInDoubt).toHaveBeenCalledWith('api', 231, true);
    expect(container.querySelector('.wd-review-in-doubt')).toBeNull();
  });

  it('a submit a stopped work web left (shown stale): in doubt, never "Submitting…" for good — you say whether it went (#64 F001)', async () => {
    const left: PrReviewWire = {
      ...review,
      submitting: { at: '2026-11-02T10:00:00Z', pid: 9, event: 'approve', drafts: [{ id: 'd1', body: 'x' }], summary: null, stale: true },
    };
    api.fetchReview.mockResolvedValue(left);
    api.settleReviewInDoubt.mockResolvedValue(review);
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const banner = container.querySelector('.wd-review-in-doubt')!;
    expect(banner.textContent).toContain('work stopped while submitting it');
    expect(container.textContent).not.toContain('Submitting…');
    expect(button('Submit review on GitHub').disabled).toBe(true);
    await act(async () => button("It didn't").click());
    await flush();
    expect(api.settleReviewInDoubt).toHaveBeenCalledWith('api', 231, false);
    expect(container.querySelector('.wd-review-in-doubt')).toBeNull();
  });

  it('drafts set aside (off the diff) are listed with their text, and can be forgotten', async () => {
    api.clearReviewDropped.mockResolvedValue({ ...review, dropped: undefined });
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    const aside = container.querySelector('.wd-review-dropped')!;
    expect(aside.textContent).toContain('1 comment set aside: not on a line of the diff');
    expect(aside.textContent).toContain('src/Shop.Orders/Pricing/Rounding.cs:90 · AI');
    expect(aside.textContent).toContain('Is MidpointRounding used the same way');
    await act(async () => button('Forget them').click());
    await flush();
    expect(api.clearReviewDropped).toHaveBeenCalledWith('api', 231);
    expect(container.querySelector('.wd-review-dropped')).toBeNull();
  });

  it('a review left preparing by a work web that stopped: its button works again', async () => {
    const left: PrReviewWire = { ...review, status: 'running', at: '2020-01-01T00:00:00Z' };
    api.fetchReview.mockResolvedValue(left);
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    expect(button('Prepare it now').disabled).toBe(false);
    api.fetchReview.mockResolvedValue({ ...left, at: new Date().toISOString() });
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    expect(button('Preparing…').disabled).toBe(true);
  });

  it('Fix it myself: every draft ticked; the ticked ones go, the unticked stay; the session opens, and the review says where they went', async () => {
    const onOpenSession = vi.fn();
    const [d1, d2] = review.drafts;
    api.fixReviewMyself.mockResolvedValue({
      sessionId: 'sess1',
      created: true,
      review: {
        ...review,
        drafts: [d2],
        fixingMyself: [
          {
            at: '2026-11-02T11:00:00Z',
            sessionId: 'sess1',
            branch: 'feat/refunds',
            comments: [{ path: d1.path, line: d1.line, body: d1.body }],
          },
        ],
      },
    });
    act(() =>
      root.render(createElement(ReviewsTab, { onOpenSession, sessionName: (id: string) => (id === 'sess1' ? 'Refunds fixes' : null) })),
    );
    await flush();
    act(() => button('Fix it myself…').click());
    const dialog = container.querySelector('[role="dialog"]')!;
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    expect(dialog.textContent).toContain(`${d1.path}:${d1.line} · AI`);
    expect(dialog.textContent).toContain('asks you before pushing');
    act(() => boxes[1].click());
    expect(button('Fix 1 myself')).toBeDefined();
    await act(async () => button('Fix 1 myself').click());
    await flush();
    expect(api.fixReviewMyself).toHaveBeenCalledWith('api', 231, [d1.id]);
    expect(onOpenSession).toHaveBeenCalledWith('sess1');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.wd-review-fixing')!.textContent).toContain('1 comment being fixed in Refunds fixes');
    expect(container.querySelector('.wd-review-submit')!.textContent).toContain('1 comment on the diff');
  });

  it("Fix it myself is disabled with the reason for a fork's PR; a refusal is said in the dialog", async () => {
    api.fetchReview.mockResolvedValue({ ...review, fork: true });
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    expect(button('Fix it myself…').disabled).toBe(true);
    expect(button('Fix it myself…').title).toContain('fork');

    api.fetchReview.mockResolvedValue(review);
    api.fixReviewMyself.mockRejectedValue(new Error('Your local branch feat/refunds and the PR’s have gone separate ways'));
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    act(() => button('Fix it myself…').click());
    await act(async () => button('Fix 2 myself').click());
    await flush();
    expect(container.querySelector('[role="dialog"] .wd-modal-error')!.textContent).toContain('gone separate ways');
  });
});
