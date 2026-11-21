// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { reviewFreshness, showsReview } from '../../src/web/src/state/review-view.js';
import { ReviewFreshness } from '../../src/web/src/components/Dashboard/tabs/review/ReviewFreshness.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Where a review stands, above it (reported: after Prepare again nothing said whether it was running, done, or the old one). */
const NOW = Date.parse('2026-11-21T09:30:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('reviewFreshness', () => {
  it('being prepared again: since when, and that what is below is the previous one, from when', () => {
    expect(reviewFreshness({ status: 'running', at: minsAgo(2), preparedAt: minsAgo(180) }, NOW)).toEqual({
      kind: 'preparing',
      text: 'Preparing a new review — started 2 min ago. Below is the previous one, prepared 3 h ago; it is replaced when the new one is ready.',
    });
    expect(reviewFreshness({ status: 'running', at: minsAgo(0), preparedAt: minsAgo(60 * 49) }, NOW)?.text).toContain(
      'started just now. Below is the previous one, prepared 2 days ago',
    );
  });

  it('being prepared for the first time: nothing below yet, and roughly how long', () => {
    expect(reviewFreshness({ status: 'running', at: minsAgo(1) }, NOW)).toEqual({
      kind: 'preparing',
      text: 'Preparing the review — started 1 min ago. It shows here when it’s ready, usually in a few minutes.',
    });
  });

  it('a new try that failed keeps the previous one below, and says why', () => {
    expect(reviewFreshness({ status: 'failed', at: minsAgo(5), preparedAt: minsAgo(90), why: 'the fetch timed out' }, NOW)).toEqual({
      kind: 'failed',
      text: 'Preparing it again failed 5 min ago: the fetch timed out. Below is the previous one, prepared 1 h ago.',
    });
  });

  it('ready: when it was prepared; anything else is the page’s own line to say', () => {
    expect(reviewFreshness({ status: 'ready', at: minsAgo(6), preparedAt: minsAgo(6) }, NOW)).toEqual({
      kind: 'ready',
      text: 'Prepared 6 min ago',
    });
    expect(reviewFreshness({ status: 'failed', at: minsAgo(1), why: 'x' }, NOW)).toBeNull();
    expect(reviewFreshness({ status: 'waiting', at: minsAgo(1), preparedAt: minsAgo(9) }, NOW)).toBeNull();
    expect(reviewFreshness({ status: 'ready' }, NOW)).toBeNull();
  });

  it('a page shows the review when it is ready, or keeps the previous one while a new one is prepared or failed', () => {
    expect(showsReview({ status: 'ready' })).toBe(true);
    expect(showsReview({ status: 'running', preparedAt: minsAgo(9) })).toBe(true);
    expect(showsReview({ status: 'failed', preparedAt: minsAgo(9) })).toBe(true);
    expect(showsReview({ status: 'running' })).toBe(false);
    expect(showsReview({ status: 'waiting', preparedAt: minsAgo(9) })).toBe(false);
  });
});

describe('ReviewFreshness on the page', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('a bar while it is prepared, its time counting up; "New review ready" when it lands, for a while; then when it was prepared', () => {
    act(() => root.render(createElement(ReviewFreshness, { status: 'running', at: minsAgo(0), preparedAt: minsAgo(120) })));
    const bar = () => container.querySelector('.wd-review-freshness');
    expect(bar()?.className).toContain('wd-review-freshness-preparing');
    expect(bar()?.getAttribute('role')).toBe('status');
    expect(bar()?.textContent).toContain('started just now');
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(bar()?.textContent).toContain('started 3 min ago');
    act(() => root.render(createElement(ReviewFreshness, { status: 'ready', at: minsAgo(-3), preparedAt: minsAgo(-3) })));
    expect(bar()?.className).toContain('wd-review-freshness-new');
    expect(bar()?.textContent).toBe('New review ready · Prepared just now');
    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(container.querySelector('.wd-review-freshness')).toBeNull();
    expect(container.querySelector('.wd-review-freshness-when')?.textContent).toMatch(/^Prepared /);
  });

  it('a review that was ready when the page opened says only when it was prepared', () => {
    act(() => root.render(createElement(ReviewFreshness, { status: 'ready', at: minsAgo(30), preparedAt: minsAgo(30) })));
    expect(container.querySelector('.wd-review-freshness')).toBeNull();
    expect(container.querySelector('.wd-review-freshness-when')?.textContent).toBe('Prepared 30 min ago');
  });
});
