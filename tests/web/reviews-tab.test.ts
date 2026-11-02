// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { demoReview } from '../../src/server/demo/demo-reviews.js';
import { summaryOf } from '../../src/core/review/review-build.js';
import type { PrReviewWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  fetchReviews: vi.fn(),
  fetchReview: vi.fn(),
  fetchReviewDiff: vi.fn(),
  prepareReview: vi.fn(),
  postReviewDraft: vi.fn(),
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
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  review = demoReview(new Date('2026-11-02T10:00:00Z'));
  for (const f of Object.values(api)) f.mockReset();
  api.fetchReviews.mockResolvedValue({ reviews: [summaryOf(review)], today: 1, maxPerDay: 10 });
  api.fetchReview.mockResolvedValue(review);
  api.fetchReviewDiff.mockResolvedValue({ files: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ReviewsTab', () => {
  it('opens the newest review: tests and gaps first, stories riskiest first with their reasoning, files by kind with why', async () => {
    const shown = vi.fn();
    act(() => root.render(createElement(ReviewsTab, { onShown: shown })));
    await flush();
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('1 of 10 automatic reviews today');
    expect(text).toContain('2 added · 0 changed · 0 removed · 0 skipped');
    expect(text).toContain('The schema changes, and only unit tests changed with it.');
    expect(text).toContain('No test touches:');
    expect(text.indexOf('Refunds an order')).toBeLessThan(text.indexOf('Rounding half away from zero'));
    expect(text).toContain('Why ranked here: moves money');
    expect(text).toContain('can lose data');
    expect(text).toContain('asserts: nothing yet: its body is empty (AI)');
    // Generated and mechanical are folded, with a count; the rest list each file and its rule.
    expect(text).toContain('▸ Generated · 3');
    expect(text).toContain('▸ Mechanical · 1');
    expect(text).toContain('controller or endpoint');
    expect(text).not.toContain('EF Core migration designer');
    act(() => button('Generated · 3').click());
    expect(container.textContent).toContain('EF Core migration designer');
  });

  it('a draft is posted only on its Post, with your edit; Discard drops it', async () => {
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    await flush();
    const area = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(area, 'Use a row version.');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(api.postReviewDraft).not.toHaveBeenCalled();
    api.postReviewDraft.mockResolvedValue({
      ...review,
      drafts: review.drafts.map((d, i) => (i === 0 ? { ...d, state: 'posted', url: 'u' } : d)),
    });
    await act(async () => button('Post').click());
    expect(api.postReviewDraft).toHaveBeenCalledWith('api', 231, 'd1', 'Use a row version.');
    expect(container.textContent).toContain('posted ↗');
    api.discardReviewDraft.mockResolvedValue({ ...review, drafts: [] });
    await act(async () => button('Discard').click());
    expect(api.discardReviewDraft).toHaveBeenCalledWith('api', 231, 'd2');
  });

  it('a waiting review says why, and Prepare it now prepares it', async () => {
    const waiting: PrReviewWire = {
      ...review,
      status: 'waiting',
      why: '4812 changed lines: over the size limit (3000), so it waits for your click',
    };
    api.fetchReviews.mockResolvedValue({ reviews: [summaryOf(waiting)], today: 0, maxPerDay: 10 });
    api.fetchReview.mockResolvedValue(waiting);
    api.prepareReview.mockResolvedValue(review);
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    await flush();
    expect(container.textContent).toContain('over the size limit (3000)');
    await act(async () => button('Prepare it now').click());
    expect(api.prepareReview).toHaveBeenCalledWith('api', 231);
    expect(container.textContent).toContain('Stories, riskiest first');
  });

  it('settings: each project with its mode and where it comes from; a change is saved', async () => {
    api.fetchReviewSettings.mockResolvedValue({
      projects: [
        { name: 'api', kind: 'repo', mode: 'asked', from: 'group', group: 'shop' },
        { name: 'shop', kind: 'group', mode: 'asked', from: 'repo' },
      ],
      maxPerDay: 10,
      maxLines: 3000,
    });
    api.saveReviewMode.mockImplementation(async () => api.fetchReviewSettings());
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    act(() => button('Which PRs').click());
    await flush();
    expect(container.textContent).toContain('(from the group shop)');
    expect(container.textContent).toContain('at most 10 a day');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Reviews for api"]')!;
    await act(async () => {
      select.value = 'off';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.saveReviewMode).toHaveBeenCalledWith('api', 'off');
  });
});
