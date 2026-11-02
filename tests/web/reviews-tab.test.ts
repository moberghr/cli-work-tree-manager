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
});
