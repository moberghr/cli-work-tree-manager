// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { demoReview, demoReviewFiles } from '../../src/server/demo/demo-reviews.js';
import { summaryOf } from '../../src/core/review/review-build.js';
import type { PrReviewWire } from '../../src/core/api-types.js';
import type { ReviewRoute } from '../../src/web/src/state/dashboard-route.js';

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
let routes: Array<ReviewRoute | null>;
const flush = async () => {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const buttons = () => [...container.querySelectorAll('button')];
const button = (text: string) => buttons().find((b) => b.textContent?.includes(text))!;
const text = (sel: string) => container.querySelector(sel)?.textContent ?? '';
const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
const OVERVIEW: ReviewRoute = { repo: 'api', number: 231, mode: 'overview', at: 0 };

/** The tab as the dashboard has it: the route in the URL (here, state), every move reported. */
function Harness(props: { start?: ReviewRoute | null; extra?: Record<string, unknown> }) {
  const [route, setRoute] = useState<ReviewRoute | null>(props.start === undefined ? OVERVIEW : props.start);
  return createElement(ReviewsTab, {
    route,
    onRoute: (r: ReviewRoute | null) => {
      routes.push(r);
      setRoute(r);
    },
    ...props.extra,
  });
}
const render = async (props: { start?: ReviewRoute | null; extra?: Record<string, unknown> } = {}) => {
  act(() => root.render(createElement(Harness, props)));
  await flush();
};

beforeEach(() => {
  localStorage.clear();
  routes = [];
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

describe('the list of reviews', () => {
  it('is the page while no review is open: by repo (the host where it isn’t GitHub), or None as one list', async () => {
    await render({ start: null });
    const heads = [...container.querySelectorAll('.wd-reviews-group-head')].map((h) => h.textContent);
    expect(heads).toEqual(['api · 1', 'payments · 1 · Azure DevOps']);
    expect(container.textContent).toContain('1 prepared today');
    expect(container.querySelector('.wd-review')).toBeNull();
    act(() => button('None').click());
    expect(container.querySelectorAll('.wd-reviews-group-head')).toHaveLength(0);
    expect(text('.wd-reviews-list')).toContain('payments #57');
  });

  it('a row opens its review on the overview; the list folds away, and Reviews ▾ brings it back beside it', async () => {
    await render({ start: null });
    await act(async () => button('#231').click());
    await flush();
    expect(routes.at(-1)).toEqual(OVERVIEW);
    expect(text('.wd-review-header h2')).toContain('api #231');
    expect(container.querySelector('.wd-reviews-list')).toBeNull();
    expect(container.querySelector('.wd-reviews')!.className).toContain('wd-reviews-nolist');
    act(() => button('Reviews (2) ▾').click());
    expect(container.querySelector('.wd-reviews-list')).not.toBeNull();
    expect(container.querySelector('.wd-resize-divider')).not.toBeNull();
    act(() => button('Reviews (2) ▾').click());
    expect(container.querySelector('.wd-reviews-list')).toBeNull();
  });

  it('the session rail: its toggle folds it (the dashboard keeps it per browser)', async () => {
    const onToggleRail = vi.fn();
    await render({ extra: { railFolded: false, onToggleRail } });
    const fold = container.querySelector<HTMLButtonElement>('.wd-review-railbtn')!;
    expect(fold.getAttribute('aria-pressed')).toBe('false');
    act(() => fold.click());
    expect(onToggleRail).toHaveBeenCalledOnce();
  });
});

describe('the overview', () => {
  it('in short, the comments as a checklist, the stories as cards, what is untested, and what isn’t worth reading folded', async () => {
    await render();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Overview');
    expect(text('.wd-review-short')).toContain('Adds partial refunds to paid orders');
    const items = [...container.querySelectorAll('.wd-review-attention > ul > li')].map((li) => li.textContent);
    expect(items).toEqual([
      'RefundHandler.cs:6Two refunds at once both read the old `Refunded` — guard with a row version or a check in the update.',
      'RefundHandler.cs:7Nothing stops refunding more than the order total.',
    ]);
    expect(text('.wd-review-attention h3')).toContain('2 of 2 to look at');
    const cards = [...container.querySelectorAll('.wd-review-card')].map((c) => c.textContent);
    expect(cards[0]).toContain('1Refunds an order: handler and validator');
    expect(cards[0]).toContain('risk 5/5');
    expect(cards[0]).toContain('can lose data');
    expect(cards[0]).toContain('2 files · 2 comments · ✓ 2 tests');
    expect(cards[1]).toContain('1 file · no tests');
    expect(text('.wd-review-gaps')).toContain('Rounding.cs');
    // No diff on the overview.
    expect(container.querySelector('.wd-file')).toBeNull();
    const noise = button('Not worth reading');
    expect(noise.textContent).toBe('Not worth reading: 3 generated · 1 mechanical ▸');
    expect(text('.wd-review-noise')).not.toContain('package-lock.json');
    act(() => noise.click());
    expect(text('.wd-review-noise')).toContain('package-lock.json');
  });

  it('with no summary (an older review): the story titles as bullets', async () => {
    api.fetchReview.mockResolvedValue({ ...review, summary: undefined });
    await render();
    expect([...container.querySelectorAll('.wd-review-short li')].map((li) => li.textContent)).toEqual([
      'Refunds an order: handler and validator',
      'Rounding half away from zero',
    ]);
  });

  it('ticking a comment marks it looked at (kept per browser); a click walks to it; a card opens its story', async () => {
    await render();
    const box = container.querySelector<HTMLInputElement>('.wd-review-attention input[type="checkbox"]')!;
    act(() => box.click());
    expect(text('.wd-review-attention h3')).toContain('1 of 2 to look at');
    expect(localStorage.getItem('work-web:review-looked:api#231@a1b2c3d')).toBe('["d1"]');
    await act(async () => button('RefundHandler.cs:7').click());
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'comments', at: 1 });
    await act(async () => button('Overview').click());
    await flush();
    // Still looked at when it comes back (read from the browser's storage).
    expect(text('.wd-review-attention h3')).toContain('1 of 2 to look at');
    await act(async () => button('Rounding half away from zero').click());
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'story', at: 1 });
  });

  it('the tests strip unfolds to the breakdown', async () => {
    await render();
    const strip = container.querySelector('.wd-review-tests-strip')!;
    expect(strip.textContent).toContain('Tests: 2 added · 0 changed · 0 removed · 0 skipped');
    expect(strip.textContent).toContain('the schema changes with unit tests only');
    expect(strip.textContent).not.toContain('asserts:');
    act(() => button('Tests:').click());
    expect(text('.wd-review-tests-strip')).toContain('asserts: nothing yet: its body is empty (AI)');
  });
});

describe('one story at a time', () => {
  it('its reasoning, only its code files’ diffs, its tests folded into one line; ← Story 1 of 2 →', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 0 } });
    expect(text('.wd-review-pager-pos')).toBe('Story 1 of 2');
    const head = text('.wd-review-section-head');
    expect(head).toContain('Why together: the handler moves the money');
    expect(head).toContain('Why ranked here: moves money');
    const shown = [...container.querySelectorAll('.wd-review-diff-pane .wd-file')].map((f) => f.getAttribute('data-path'));
    expect(shown).toEqual(['src/Shop.Orders/Refunds/RefundHandler.cs', 'src/Shop.Orders/Refunds/RefundValidator.cs']);
    // The tree: every page; the open one's code files, the name whole and the folder apart.
    const tree = container.querySelector('.wd-review-tree')!;
    expect([...tree.querySelectorAll('.wd-review-tree-head')].map((b) => b.textContent)).toEqual([
      '1 Refunds an order: handler and validator',
      '2 Rounding half away from zero',
      '· Schema · 1',
      '· API surface · 1',
      '· Wiring · 1',
      '· Dependencies, build & CI · 1',
      '· Mechanical · 1',
      '· Generated · 3',
    ]);
    expect([...tree.querySelectorAll('.wd-review-tree-name')].map((n) => n.textContent)).toEqual([
      'RefundHandler.cs',
      'RefundValidator.cs',
    ]);
    expect(tree.querySelector('.wd-review-tree-file .wd-review-folder')!.textContent).toBe('+11 −0 · src/\u200bShop.Orders/\u200bRefunds');
    // Tests: one line, unfolding to the test files and their diffs.
    const tests = button('2 tests in 1 file cover this');
    expect(tests.textContent).toBe('▸ 2 tests in 1 file cover this · 2 added');
    act(() => tests.click());
    expect(text('.wd-review-story-testfiles')).toContain('RefundHandlerTests.cs');
    expect(container.querySelector('.wd-review-story-testfiles .wd-file')!.getAttribute('data-path')).toContain('RefundHandlerTests.cs');
  });

  it('a Viewed tick counts toward the story and the review (per browser); → goes to the next story, then the kinds of change', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 0 } });
    expect(text('.wd-review-progress')).toContain('0/2 viewed here · 0/7 in all');
    act(() => container.querySelector<HTMLInputElement>('.wd-viewed-checkbox')!.click());
    expect(text('.wd-review-progress')).toContain('1/2 viewed here · 1/7 in all');
    expect(localStorage.getItem('work-web:review-viewed:api#231@a1b2c3d')).toContain('RefundHandler.cs');
    await act(async () => button('Next: Rounding half away from zero').click());
    await flush();
    expect(text('.wd-review-pager-pos')).toBe('Story 2 of 2');
    expect(text('.wd-review-section-head')).toContain('No test of this PR covers it');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next story"]')!.click());
    await flush();
    expect(text('.wd-review-pager-pos')).toBe('Schema · 3 of 8');
  });

  it('a generated page lists its files and folds the diffs until asked; a new file’s imports fold into one row', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 7 } });
    expect(text('.wd-review-pager-pos')).toBe('Generated · 8 of 8');
    expect(container.querySelector('.wd-review-diff-pane .wd-file')).toBeNull();
    act(() => button('Show the diffs').click());
    expect(container.querySelectorAll('.wd-review-diff-pane .wd-file')).toHaveLength(3);

    act(() => root.unmount());
    root = createRoot(container);
    await render({ start: { ...OVERVIEW, mode: 'story', at: 3 } });
    expect(text('.wd-review-pager-pos')).toBe('API surface · 4 of 8');
    const fold = button('3 import lines');
    expect(fold.textContent).toBe('3 import lines ▸');
    expect(text('.wd-review-diff-pane')).not.toContain('using Microsoft.AspNetCore.Mvc;');
    act(() => fold.click());
    expect(text('.wd-review-diff-pane')).toContain('using Microsoft.AspNetCore.Mvc;');
  });
});

describe('the comments walk', () => {
  it('one at a time with the code around it, the draft on its line (Delete only); → to the next; Open in its story', async () => {
    await render({ start: { ...OVERVIEW, mode: 'comments', at: 0 } });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Comments (2)');
    expect(text('.wd-review-pager-pos')).toBe('1 of 2');
    const pane = container.querySelector('.wd-review-walk-pane')!;
    expect(pane.querySelector('.wd-file')!.getAttribute('data-path')).toBe('src/Shop.Orders/Refunds/RefundHandler.cs');
    expect(pane.textContent).toContain('Two refunds at once both read the old');
    const draft = pane.querySelector('.wd-status-draft')!;
    expect([...draft.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Delete']);
    // ~15 lines: the whole of this short new file, 11 lines.
    expect(pane.querySelectorAll('.wd-file .wd-row').length).toBe(11);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next comment"]')!.click());
    await flush();
    expect(text('.wd-review-pager-pos')).toBe('2 of 2');
    expect(text('.wd-review-walk-pane')).toContain('Nothing stops refunding more than the order total.');
    await act(async () => button('Open in story 1').click());
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'story', at: 0 });
  });

  it('the comments set aside are listed at the end, with their text, and can be forgotten', async () => {
    api.clearReviewDropped.mockResolvedValue({ ...review, dropped: undefined });
    await render({ start: { ...OVERVIEW, mode: 'comments', at: 0 } });
    const aside = container.querySelector('.wd-review-walk .wd-review-dropped')!;
    expect(aside.textContent).toContain('1 comment set aside: not on a line of the diff');
    expect(aside.textContent).toContain('src/Shop.Orders/Pricing/Rounding.cs:90 · AI');
    expect(aside.textContent).toContain('Is MidpointRounding used the same way');
    await act(async () => button('Forget them').click());
    await flush();
    expect(api.clearReviewDropped).toHaveBeenCalledWith('api', 231);
    expect(container.querySelector('.wd-review-dropped')).toBeNull();
  });
});

describe('the keys and the URL', () => {
  it('] [ walk the stories and the comments; o the overview, s the stories, m the comments; not while typing', async () => {
    await render();
    await key(']');
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'story', at: 0 });
    await key(']');
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'story', at: 1 });
    await key('[');
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'story', at: 0 });
    await key('m');
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'comments', at: 0 });
    await key(']');
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'comments', at: 1 });
    const n = routes.length;
    await key(']');
    expect(routes).toHaveLength(n);
    await key('o');
    expect(routes.at(-1)).toEqual(OVERVIEW);
    await key('s');
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'story', at: 0 });
    const summary = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review summary"]')!;
    summary.focus();
    const m = routes.length;
    await key('o');
    expect(routes).toHaveLength(m);
  });

  it('a position past the end shows the last one; the segmented control moves between the modes', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 99 } });
    expect(text('.wd-review-pager-pos')).toBe('Generated · 8 of 8');
    await act(async () => button('Comments (2)').click());
    expect(routes.at(-1)).toEqual({ ...OVERVIEW, mode: 'comments', at: 0 });
  });
});

describe('submitting, in every mode', () => {
  it('Submit sends every draft as one review with the verdict and summary', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 1 } });
    expect(text('.wd-review-submit')).toContain('2 comments on the diff');
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

  it('the submit bar is there in the overview and the walk too', async () => {
    await render();
    expect(container.querySelector('.wd-review-submit')).not.toBeNull();
    await act(async () => button('Comments (2)').click());
    await flush();
    expect(container.querySelector('.wd-review-submit')).not.toBeNull();
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
    await render();
    expect(container.textContent).toContain('over the size limit (3000)');
    expect(container.querySelector('.wd-review-submit')).toBeNull();
    expect(container.querySelector('.wd-review-modes')).toBeNull();
    await act(async () => button('Prepare it now').click());
    await flush();
    expect(api.prepareReview).toHaveBeenCalledWith('api', 231);
    expect(container.querySelector('.wd-review-overview')).not.toBeNull();
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
    await render({ start: null });
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
    await render();
    const partly: PrReviewWire = {
      ...review,
      drafts: review.drafts.map((d, i) => (i === 0 ? { ...d, state: 'posted' } : d)),
      submitted: { at: '2026-11-02T11:00:00Z', event: 'comment', partial: true },
    };
    api.submitReview.mockRejectedValue(new ReviewSubmitError('src/x.cs:7: TF400898', partly));
    await act(async () => button('Submit review on GitHub').click());
    await flush();
    expect(text('.wd-review-submit')).toContain('src/x.cs:7: TF400898');
    expect(text('.wd-review-submit')).toContain('1 comment on the diff');
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
    await render();
    expect(text('.wd-review-in-doubt')).toContain('may have gone out (gh timed out): 1 comment and the summary');
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
    await render();
    expect(text('.wd-review-in-doubt')).toContain('work stopped while submitting it');
    expect(container.textContent).not.toContain('Submitting…');
    expect(button('Submit review on GitHub').disabled).toBe(true);
    await act(async () => button("It didn't").click());
    await flush();
    expect(api.settleReviewInDoubt).toHaveBeenCalledWith('api', 231, false);
    expect(container.querySelector('.wd-review-in-doubt')).toBeNull();
  });

  it('a review left preparing by a work web that stopped: its button works again', async () => {
    const left: PrReviewWire = { ...review, status: 'running', at: '2020-01-01T00:00:00Z' };
    api.fetchReview.mockResolvedValue(left);
    await render();
    expect(button('Prepare it now').disabled).toBe(false);
    api.fetchReview.mockResolvedValue({ ...left, at: new Date().toISOString() });
    act(() => root.unmount());
    root = createRoot(container);
    await render();
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
    await render({ extra: { onOpenSession, sessionName: (id: string) => (id === 'sess1' ? 'Refunds fixes' : null) } });
    act(() => button('Fix it myself…').click());
    const dialog = container.querySelector('[role="dialog"]')!;
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    expect(dialog.textContent).toContain(`${d1.path}:${d1.line} · AI`);
    expect(dialog.textContent).toContain('asks you before pushing');
    act(() => boxes[1].click());
    await act(async () => button('Fix 1 myself').click());
    await flush();
    expect(api.fixReviewMyself).toHaveBeenCalledWith('api', 231, [d1.id]);
    expect(onOpenSession).toHaveBeenCalledWith('sess1');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(text('.wd-review-fixing')).toContain('1 comment being fixed in Refunds fixes');
    expect(text('.wd-review-submit')).toContain('1 comment on the diff');
  });

  it("Fix it myself is disabled with the reason for a fork's PR; a refusal is said in the dialog", async () => {
    api.fetchReview.mockResolvedValue({ ...review, fork: true });
    await render();
    expect(button('Fix it myself…').disabled).toBe(true);
    expect(button('Fix it myself…').title).toContain('fork');

    api.fetchReview.mockResolvedValue(review);
    api.fixReviewMyself.mockRejectedValue(new Error('Your local branch feat/refunds and the PR’s have gone separate ways'));
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    act(() => button('Fix it myself…').click());
    await act(async () => button('Fix 2 myself').click());
    await flush();
    expect(container.querySelector('[role="dialog"] .wd-modal-error')!.textContent).toContain('gone separate ways');
  });
});

describe('without a router (kept in the tab)', () => {
  it('a row opens the review; the modes move within it', async () => {
    act(() => root.render(createElement(ReviewsTab, {})));
    await flush();
    await act(async () => button('#231').click());
    await flush();
    expect(text('.wd-review-header h2')).toContain('api #231');
    await act(async () => button('Stories (2)').click());
    await flush();
    expect(text('.wd-review-pager-pos')).toBe('Story 1 of 2');
  });
});
