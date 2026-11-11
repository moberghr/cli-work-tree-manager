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
  refreshReviewDiscussion: vi.fn(),
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
/** A button of the submit bar by its whole label ("Comment" isn't the "Comments (2)" tab). */
const verdict = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-review-submit button')].find((b) => b.textContent === label)!;
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
  // Opening a review reads its discussion again: here it answers the review as fetchReview does.
  api.refreshReviewDiscussion.mockImplementation((repo: string, n: number) => api.fetchReview(repo, n));
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
      'ARefundHandler.cs:6Ivo’s open question about locking the row is still not answered by the code: two refunds at once both read the old `Refunded`.',
      'ARefundHandler.cs:7Nothing stops refunding more than the order total.',
    ]);
    expect(text('.wd-review-attention h3')).toContain('2 of 2 to look at');
    const cards = [...container.querySelectorAll('.wd-review-card')].map((c) => c.textContent);
    expect(cards[0]).toContain('1Support staff can now refund part of a paid order, and the refunded amount is recorded on the order.');
    expect(cards[0]).toContain('risk 5/5');
    expect(cards[0]).toContain('can lose data');
    // Its first sentence of what it does under the title; the whole on hover. Its untested validator said beside the tests.
    expect(cards[0]).toContain('A refund request for an order is sent to the payment provider');
    expect(cards[0]).not.toContain('Existing orders start with a Refunded total of 0');
    expect(container.querySelector<HTMLButtonElement>('.wd-review-card')!.title).toContain(
      'Existing orders start with a Refunded total of 0',
    );
    expect(cards[0]).toContain('2 files · 2 comments · ✓ 2 tests · 1 file untested');
    expect(cards[1]).toContain('1 file · no tests');
    expect(text('.wd-review-gaps')).toContain('Rounding.cs');
    // Where a comment is: the change badge, the name bold, the line apart.
    const where = container.querySelector('.wd-review-attention .wd-review-where')!;
    expect(where.querySelector('.wd-review-badge-added')!.textContent).toBe('A');
    expect(where.querySelector('.wd-review-filename')!.textContent).toBe('RefundHandler.cs');
    expect(where.querySelector('.wd-review-fileline')!.textContent).toBe(':6');
    // An untested file: its badge, its counts in colour, its folder under it.
    const gap = container.querySelector('.wd-review-gaps .wd-review-filerow')!;
    const firstGap = review.files.find((f) => f.path === review.tests.gaps[0])!;
    expect(gap.querySelector('.wd-review-badge')!.textContent).toBe(firstGap.status === 'added' ? 'A' : 'M');
    expect(gap.querySelector('.wd-review-plus')!.textContent).toMatch(/^\+\d+$/);
    expect(gap.querySelector('.wd-review-minus')!.textContent).toMatch(/^−\d+$/);
    expect(gap.querySelectorAll('.wd-review-diffstat .wd-review-block')).toHaveLength(5);
    // The folder wraps only after a slash: a break opportunity there, none inside a name.
    const gapFolder = gap.querySelector('.wd-review-folder')!;
    expect(gapFolder.textContent).toBe(firstGap.path.slice(0, firstGap.path.lastIndexOf('/')));
    expect(gapFolder.innerHTML).toBe(firstGap.path.slice(0, firstGap.path.lastIndexOf('/')).split('/').join('/<wbr>'));
    // No diff on the overview.
    expect(container.querySelector('.wd-file')).toBeNull();
    const noise = button('Not worth reading');
    expect(noise.textContent).toBe('Not worth reading: 2 generated · 1 mechanical · 1 designer file left out ▸');
    expect(text('.wd-review-noise')).not.toContain('package-lock.json');
    act(() => noise.click());
    expect(text('.wd-review-noise')).toContain('package-lock.json');
    // The designer file is named there, never diffed.
    expect(text('.wd-review-noise')).toContain('20261102_AddRefunds.Designer.cs');
    expect(text('.wd-review-noise')).toContain('left out of the review: a designer file, never read');
  });

  it('with no summary (an older review): the story titles as bullets', async () => {
    api.fetchReview.mockResolvedValue({ ...review, summary: undefined });
    await render();
    expect([...container.querySelectorAll('.wd-review-short li')].map((li) => li.textContent)).toEqual([
      'Support staff can now refund part of a paid order, and the refunded amount is recorded on the order.',
      'Prices that end in half a cent now round away from zero instead of to the nearest even cent.',
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
    await act(async () => button('Prices that end in half a cent now round away from zero instead of to the nearest even cent.').click());
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
    // Its sentence, then what it does, why together and why ranked here: each a heading and a paragraph.
    expect(text('.wd-review-section-head h3')).toBe(review.stories[0].title);
    const parts = [...container.querySelectorAll('.wd-review-story-text section')].map((sec) => [
      sec.querySelector('h4')!.textContent,
      sec.querySelector('p')!.textContent,
    ]);
    expect(parts).toEqual([
      ['What it does', review.stories[0].what],
      ['Why these files belong together', review.stories[0].why],
      ['Why it’s ranked here', review.stories[0].risk],
    ]);
    expect(head).toContain('risk 5/5');
    const shown = [...container.querySelectorAll('.wd-review-diff-pane .wd-file')].map((f) => f.getAttribute('data-path'));
    expect(shown).toEqual(['src/Shop.Orders/Refunds/RefundHandler.cs', 'src/Shop.Orders/Refunds/RefundValidator.cs']);
    // The tree: every page; the open one's code files, the name whole and the folder apart.
    const tree = container.querySelector('.wd-review-tree')!;
    expect([...tree.querySelectorAll('.wd-review-tree-head')].map((b) => b.textContent)).toEqual([
      '1 Support staff can now refund part of a paid order, and the refunded amount is recorded on the order.',
      '2 Prices that end in half a cent now round away from zero instead of to the nearest even cent.',
      '· Schema · 1',
      '· API surface · 1',
      '· Wiring · 1',
      '· Dependencies, build & CI · 1',
      '· Mechanical · 1',
      '· Generated · 2',
    ]);
    expect([...tree.querySelectorAll('.wd-review-tree-name')].map((n) => n.textContent)).toEqual([
      'RefundHandler.cs',
      'RefundValidator.cs',
    ]);
    // No folder line in the tree: the diff's header has the path, and the row's tooltip (below).
    expect(tree.querySelector('.wd-review-tree-file .wd-review-folder')).toBeNull();
    // Each file row: the change badge, the name bold, its draft comments, its counts green and red with a diffstat.
    const row = tree.querySelector('.wd-review-tree-file')!;
    expect(row.querySelector('.wd-review-badge-added')!.textContent).toBe('A');
    expect(row.querySelector('.wd-review-badge')!.getAttribute('title')).toBe('Added');
    expect(row.querySelector('.wd-review-filecomments')!.textContent).toBe('2');
    expect(row.querySelector('.wd-review-filecomments')!.getAttribute('title')).toBe('2 draft comments');
    expect(row.querySelector('.wd-review-plus')!.textContent).toBe('+11');
    expect(row.querySelector('.wd-review-minus')!.textContent).toBe('−0');
    expect([...row.querySelectorAll('.wd-review-block')].map((b) => b.className)).toEqual(
      Array(5).fill('wd-review-block wd-review-block-add'),
    );
    // The second file has no comments; the first one's diff is on screen when the story opens.
    expect(tree.querySelectorAll('.wd-review-tree-file')[1].querySelector('.wd-review-filecomments')).toBeNull();
    expect(row.classList.contains('wd-review-filerow-current')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');
    // The story heads: number in a ring, the risk as a stripe.
    const heads = tree.querySelectorAll('.wd-review-tree-head');
    expect(heads[0].classList.contains('wd-review-tree-risk-5')).toBe(true);
    expect(heads[0].getAttribute('title')).toContain('Risk 5/5');
    expect(heads[2].className).toBe('wd-review-tree-head');
    // A file's tooltip: its path and what changed in it.
    const handler = review.files.find((f) => f.path.endsWith('RefundHandler.cs'))!;
    expect(tree.querySelector<HTMLButtonElement>('.wd-review-tree-file')!.title).toBe(`${handler.path}\n\n${handler.summary}`);
    // Each file: what changed here, under its header and above its code; it folds to its heading.
    const first = container.querySelector('.wd-review-diff-pane .wd-file')!;
    const note = first.querySelector('.wd-file-header + .wd-file-note .wd-review-file-summary')!;
    expect(note.querySelector('summary')!.textContent).toBe('What changed here');
    expect(note.textContent).toContain('New handler that loads the order');
    expect(note.hasAttribute('open')).toBe(true);
    expect(first.lastElementChild!.contains(note)).toBe(false); // the code comes after it
    // Tests: one line, unfolding to the test files and their diffs.
    const tests = button('2 tests in 1 file cover this');
    expect(tests.textContent).toBe('▸ 2 tests in 1 file cover this · 2 added');
    act(() => tests.click());
    expect(text('.wd-review-story-testfiles')).toContain('RefundHandlerTests.cs');
    expect(container.querySelector('.wd-review-story-testfiles .wd-file')!.getAttribute('data-path')).toContain('RefundHandlerTests.cs');
    // Reported: they couldn't be closed once their diffs pushed the line away. Hide is at both ends of them.
    const hides = container.querySelectorAll<HTMLButtonElement>('.wd-review-tests-hide');
    expect(hides).toHaveLength(2);
    act(() => hides[1].click());
    expect(container.querySelector('.wd-review-story-testfiles')).toBeNull();
    act(() => button('2 tests in 1 file cover this').click());
    act(() => container.querySelector<HTMLButtonElement>('.wd-review-tests-hide')!.click());
    expect(container.querySelector('.wd-review-story-testfiles')).toBeNull();
  });

  it('code the AI step names between backticks is drawn as code; the tooltips have it plain', async () => {
    const handler = 'src/Shop.Orders/Refunds/RefundHandler.cs';
    api.fetchReview.mockResolvedValue({
      ...review,
      stories: [{ ...review.stories[0], what: 'It calls `IPayments.Refund` first. Then it saves.' }, review.stories[1]],
      files: review.files.map((f) => (f.path === handler ? { ...f, summary: 'Adds `RefundHandler`.' } : f)),
    });
    await render({ start: { ...OVERVIEW, mode: 'story', at: 0 } });
    expect([...container.querySelectorAll('.wd-review-story-text code')].map((c) => c.textContent)).toEqual(['IPayments.Refund']);
    expect(text('.wd-review-story-text')).not.toContain('`');
    expect(container.querySelector('.wd-file-note code')!.textContent).toBe('RefundHandler');
    expect(container.querySelector<HTMLButtonElement>('.wd-review-tree-file')!.title).toBe(`${handler}\n\nAdds RefundHandler.`);
  });

  it('a review from before (no "what", no file summaries): the reasons alone, no note over the code', async () => {
    api.fetchReview.mockResolvedValue({
      ...review,
      stories: review.stories.map(({ what: _w, ...s }) => s),
      files: review.files.map(({ summary: _s, ...f }) => f),
    });
    await render({ start: { ...OVERVIEW, mode: 'story', at: 0 } });
    expect([...container.querySelectorAll('.wd-review-story-text h4')].map((h) => h.textContent)).toEqual([
      'Why these files belong together',
      'Why it’s ranked here',
    ]);
    expect(container.querySelector('.wd-file-note')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.wd-review-tree-file')!.title).toContain(' — ');
  });

  it('a Viewed tick counts toward the story and the review (per browser); → goes to the next story, then the kinds of change', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 0 } });
    expect(text('.wd-review-progress')).toContain('0/2 viewed here · 0/7 in all');
    act(() => container.querySelector<HTMLInputElement>('.wd-viewed-checkbox')!.click());
    expect(text('.wd-review-progress')).toContain('1/2 viewed here · 1/7 in all');
    expect(localStorage.getItem('work-web:review-viewed:api#231@a1b2c3d')).toContain('RefundHandler.cs');
    // The tree's row says so: a ✓ and dimmed; the other file isn't.
    const rows = container.querySelectorAll('.wd-review-tree-file');
    expect(rows[0].classList.contains('wd-review-filerow-viewed')).toBe(true);
    expect(rows[0].querySelector('.wd-review-fileviewed')!.textContent).toBe('✓');
    expect(rows[1].classList.contains('wd-review-filerow-viewed')).toBe(false);
    expect(rows[1].querySelector('.wd-review-fileviewed')).toBeNull();
    await act(async () => button('Next: Prices that end in half a cent now round away from zero instead of to the nearest even…').click());
    await flush();
    expect(text('.wd-review-pager-pos')).toBe('Story 2 of 2');
    expect(text('.wd-review-section-head')).toContain('No test of this PR covers it');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next story"]')!.click());
    await flush();
    expect(text('.wd-review-pager-pos')).toBe('Schema · 3 of 8');
  });

  it('the tree marks the file whose diff is on screen as the pane scrolls, and the one clicked', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 0 } });
    const rows = () => [...container.querySelectorAll('.wd-review-tree-file')];
    const current = () => rows().map((r) => r.classList.contains('wd-review-filerow-current'));
    expect(current()).toEqual([true, false]);
    // The second file's header has reached the pane's top: it's the one on screen.
    const pane = container.querySelector<HTMLElement>('.wd-review-diff-pane')!;
    const files = [...pane.querySelectorAll<HTMLElement>(':scope > .wd-review-section > .wd-review-file > .wd-file')];
    expect(files).toHaveLength(2);
    const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) });
    pane.getBoundingClientRect = () => rect(100) as DOMRect;
    files[0].getBoundingClientRect = () => rect(-500) as DOMRect;
    files[1].getBoundingClientRect = () => rect(104) as DOMRect;
    await act(async () => {
      pane.dispatchEvent(new Event('scroll'));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(current()).toEqual([false, true]);
    // A click on a file marks it at once, and keeps it marked while the pane scrolls to it.
    Element.prototype.scrollIntoView = () => undefined;
    act(() => (rows()[0] as HTMLButtonElement).click());
    expect(current()).toEqual([true, false]);
    await act(async () => {
      pane.dispatchEvent(new Event('scroll'));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(current()).toEqual([true, false]);
  });

  it('a generated page lists its files and folds the diffs until asked; a new file’s imports fold into one row', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 7 } });
    expect(text('.wd-review-pager-pos')).toBe('Generated · 8 of 8');
    expect(container.querySelector('.wd-review-diff-pane .wd-file')).toBeNull();
    act(() => button('Show the diffs').click());
    expect(container.querySelectorAll('.wd-review-diff-pane .wd-file')).toHaveLength(2);

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
    // The file's "What changed here" under its header, before the code around the comment.
    expect(pane.querySelector('.wd-file-header + .wd-file-note summary')!.textContent).toBe('What changed here');
    expect(text('.wd-review-walk-pane .wd-file-note')).toContain('New handler that loads the order');
    expect(pane.textContent).toContain('two refunds at once both read the old');
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
  it('a verdict button sends every draft as one review with that verdict and the summary', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 1 } });
    expect(text('.wd-review-submit')).toContain('2 comments on the diff');
    api.submitReview.mockResolvedValue({
      ...review,
      drafts: review.drafts.map((d) => ({ ...d, state: 'posted' })),
      submitted: { at: '2026-11-02T11:00:00Z', event: 'request-changes' },
    });
    await act(async () => verdict('Request changes').click());
    expect(api.submitReview).toHaveBeenCalledWith('api', 231, {
      event: 'request-changes',
      body: '',
      drafts: review.drafts.map((d) => ({ id: d.id, body: d.body })),
    });
    expect(container.textContent).toContain('you submitted changes requested');
  });

  it('Approve alone: no comments and no summary needed; Comment and Request changes need one', async () => {
    const bare: PrReviewWire = { ...review, drafts: [] };
    api.fetchReview.mockResolvedValue(bare);
    api.submitReview.mockResolvedValue({ ...bare, submitted: { at: '2026-11-02T11:00:00Z', event: 'approve' } });
    await render();
    expect(verdict('Comment').disabled).toBe(true);
    expect(verdict('Request changes').disabled).toBe(true);
    await act(async () => verdict('Approve').click());
    await flush();
    expect(api.submitReview).toHaveBeenCalledWith('api', 231, { event: 'approve', body: '', drafts: [] });
    expect(container.textContent).toContain('you submitted an approval');
  });

  it('while it is prepared again for a new push, the verdicts are off and say why', async () => {
    api.fetchReview.mockResolvedValue({ ...review, status: 'queued' });
    await render();
    expect(verdict('Approve').disabled).toBe(true);
    expect(verdict('Approve').title).toContain('being prepared again');
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
      held: 'size',
      why: '4812 changed lines: over the size limit (3000), so it waits for your click',
    };
    api.fetchReviews.mockResolvedValue({ reviews: [summaryOf(waiting)], today: 0, maxPerDay: null });
    api.fetchReview.mockResolvedValue(waiting);
    api.prepareReview.mockResolvedValue(review);
    await render();
    expect(container.textContent).toContain('over the size limit (3000)');
    // Where the review would be: why, and what to do — never a blank page (reported).
    expect(container.querySelector('.wd-review-not-prepared')?.textContent).toContain('Prepare it now reads it anyway');
    // Not prepared, and still approvable (reported: no way to just approve a PR).
    expect(verdict('Approve').disabled).toBe(false);
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
    await act(async () => verdict('Comment').click());
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
    for (const v of ['Comment', 'Request changes', 'Approve']) expect(verdict(v).disabled).toBe(true);
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
    for (const v of ['Comment', 'Request changes', 'Approve']) expect(verdict(v).disabled).toBe(true);
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

describe("the PR's existing discussion (read only)", () => {
  it('opening a review reads it again from the host', async () => {
    await render();
    expect(api.refreshReviewDiscussion).toHaveBeenCalledWith('api', 231);
  });

  it('the overview: Already discussed — threads, open, verdicts, the conversation, and the outdated thread listed apart', async () => {
    await render();
    const sec = container.querySelector('[aria-label="Already discussed"]')!;
    expect(sec.querySelector('.wd-review-discussed-line')!.textContent).toContain(
      '3 threads, 2 open · 1 resolved · 1 outdated · 1 comment on the PR',
    );
    expect(sec.textContent).toContain('approved by @ana');
    const list = [...sec.querySelectorAll('.wd-review-discussed-list li')].map((li) => li.textContent);
    expect(list[0]).toContain('approved @ana Fine once the row locking is sorted.');
    expect(list[1]).toContain('comment @lea Can this go in before Friday’s release?');
    expect(sec.querySelectorAll('.wd-review-discussed-list a')[0].getAttribute('href')).toBe(
      'https://github.com/example/api/pull/231#discussion_v2',
    );
    // Its outdated thread, which has no line in the diff: listed, marked.
    const aside = sec.querySelector('.wd-host-aside')!;
    expect(aside.querySelector('summary')!.textContent).toContain('1 thread on GitHub not on a line of this diff');
    expect(aside.querySelector('.wd-host-where')!.textContent).toBe('Rounding.cs (was line 3)');
    expect(aside.querySelector('.wd-host-outdated')!.textContent).toBe('outdated');
    act(() => button('See them on their lines').click());
    expect(routes.at(-1)).toMatchObject({ mode: 'files' });
  });

  it('a review from before (none read yet) says so', async () => {
    api.fetchReview.mockResolvedValue({ ...review, discussion: undefined });
    await render();
    expect(text('[aria-label="Already discussed"]')).toContain('Not read from GitHub yet');
  });

  it('in a story: on its line, apart from the drafts — read only, its link to the host; a resolved one folded and dimmed', async () => {
    await render({ start: { ...OVERVIEW, mode: 'story', at: 0 } });
    const pane = container.querySelector('.wd-review-diff-pane')!;
    const threads = [...pane.querySelectorAll('.wd-host-thread')];
    expect(threads.map((t) => t.getAttribute('data-thread'))).toEqual(['PRRT_demo1', 'PRRT_demo2']);
    const open = threads[0] as HTMLDetailsElement;
    expect(open.open).toBe(true);
    expect(open.textContent).toContain('on GitHub');
    expect(open.textContent).toContain('@ivomember');
    expect(open.textContent).toContain('Is FindAsync enough here');
    expect(open.querySelector('a')!.textContent).toBe('Open on GitHub ↗');
    expect(open.querySelectorAll('button')).toHaveLength(0);
    // The host's thread sits with the AI's draft on the same line, the draft still the draft (Delete), the thread not.
    const row = open.closest('.wd-comment-list')!;
    expect(row.querySelector('.wd-status-draft')).not.toBeNull();
    const resolved = threads[1] as HTMLDetailsElement;
    expect(resolved.open).toBe(false);
    expect(resolved.className).toContain('wd-host-thread-resolved');
    expect(resolved.querySelector('summary')!.textContent).toContain('@ana: Should a refund of 0 be allowed?');
    // The tree says which files have open threads on the host.
    expect(text('.wd-review-tree-current .wd-review-filethreads')).toBe('1');
  });

  it('the comments walk shows the thread on the commented line too', async () => {
    await render({ start: { ...OVERVIEW, mode: 'comments', at: 0 } });
    expect(container.querySelector('.wd-review-walk-pane .wd-host-thread[data-thread="PRRT_demo1"]')).not.toBeNull();
  });
});

describe('the Files view (GitHub’s Files changed)', () => {
  it('every file in a folder tree and every diff in one scroll, in the tree’s order; generated ones folded until Load diff', async () => {
    await render({ start: { ...OVERVIEW, mode: 'files' } });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe(`Files (${review.files.length})`);
    const dirs = [...container.querySelectorAll('.wd-review-ftree-dir')].map((d) => d.textContent);
    expect(dirs).toContain('▾src');
    expect(dirs).toContain('▾Shop.Orders');
    const tree = [...container.querySelectorAll('.wd-review-ftree .wd-review-tree-name')].map((n) => n.textContent);
    const diffs = [...container.querySelectorAll('.wd-review-files .wd-review-diff-pane .wd-file')].map((f) =>
      f.getAttribute('data-path')!.split('/').pop(),
    );
    expect(diffs).toEqual(tree);
    expect(diffs).toHaveLength(review.files.length);
    // Folders first, then files, each by name.
    expect(tree.indexOf('RefundsController.cs')).toBeLessThan(tree.indexOf('Program.cs'));
    expect(text('.wd-review-files .wd-review-progress')).toContain(`0 / ${review.files.length} viewed`);
    // The designer file isn't in the Files view at all: the review leaves it out.
    expect(container.querySelector('.wd-file[data-path$=".Designer.cs"]')).toBeNull();
    const generated = container.querySelector('.wd-file[data-path="src/Shop.Data/Migrations/ShopDbModelSnapshot.cs"]')!;
    expect(generated.textContent).toContain('Generated file — not rendered by default');
    act(() => [...generated.querySelectorAll('button')].find((b) => b.textContent === 'Load diff')!.click());
    expect(generated.textContent).toContain('Refunded');
  });

  it('the same Viewed ticks as the stories; a folder folds; a file picked goes in the URL; f opens the view', async () => {
    await render({ start: { ...OVERVIEW, mode: 'files' } });
    const handler = container.querySelector('.wd-file[data-path="src/Shop.Orders/Refunds/RefundHandler.cs"]')!;
    // Its open thread on the host on its line, here too; the outdated one listed on top.
    expect(handler.querySelector('.wd-host-thread[data-thread="PRRT_demo1"]')).not.toBeNull();
    expect(text('.wd-review-files .wd-host-aside summary')).toContain('1 thread on GitHub not on a line of this diff');
    act(() => handler.querySelector<HTMLInputElement>('.wd-viewed-checkbox')!.click());
    expect(text('.wd-review-files .wd-review-progress')).toContain(`1 / ${review.files.length} viewed`);
    const stored = Object.keys(localStorage).find((k) => k.includes('viewed'))!;
    expect(localStorage.getItem(stored)).toContain('src/Shop.Orders/Refunds/RefundHandler.cs');
    const before = container.querySelectorAll('.wd-review-ftree .wd-review-tree-name').length;
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('.wd-review-ftree-dir')]
        .find((d) => d.textContent === '▾tests/Shop.Orders.Tests')!
        .click(),
    );
    expect(container.querySelectorAll('.wd-review-ftree .wd-review-tree-name').length).toBe(before - 1);
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('.wd-review-ftree .wd-review-filerow')]
        .find((b) => b.textContent?.includes('Program.cs'))!
        .click(),
    );
    expect(routes.at(-1)).toEqual({ repo: 'api', number: 231, mode: 'files', at: 0, file: 'src/Shop.Api/Program.cs' });
    await key('o');
    expect(routes.at(-1)).toMatchObject({ mode: 'overview' });
    await key('f');
    expect(routes.at(-1)).toMatchObject({ mode: 'files' });
  });
});
