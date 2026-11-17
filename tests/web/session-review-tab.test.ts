// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PrReviewWire, SessionReviewWire } from '../../src/core/api-types.js';
import { localReviewLine, sendRestLabel, unsentNotes, withoutNotes } from '../../src/web/src/components/Dashboard/tabs/SessionReviewTab.js';
import { parseHash } from '../../src/web/src/state/dashboard-route.js';
import { SESSION_KEYS, sessionActionFor } from '../../src/web/src/state/shortcuts.js';
import { isLocalReview, pointsLabel } from '../../src/web/src/state/review-view.js';
import { parseSessionReviewPage, sessionReviewPagePath, sessionReviewPageTitle } from '../../src/web/src/state/session-review-page.js';

/** A session's Review tab: what it says above the review, the notes set aside, its route and its key. */
const NOW = Date.parse('2026-11-16T12:00:00Z');
const review = {
  repo: 'api',
  base: 'origin/main',
  why: null,
  size: { files: 3, added: 40, deleted: 2 },
  drafts: [
    { id: 'd1', path: 'a.cs', line: 1, body: 'x', state: 'draft' },
    { id: 'd2', path: 'b.cs', line: 2, body: 'y', state: 'draft' },
  ],
} as unknown as PrReviewWire;

describe('localReviewLine', () => {
  it('says where it stands: none yet, preparing, ready with what it covers and when, or why it failed', () => {
    expect(localReviewLine({ status: 'none', repo: null, repos: [] }, NOW)).toBe('No review of this branch’s changes is prepared yet.');
    expect(localReviewLine({ status: 'running', repo: null, repos: [] }, NOW)).toBe(
      'Preparing… reading the changes takes a minute or two.',
    );
    const ready: SessionReviewWire = { status: 'ready', repo: 'api', repos: ['api'], at: new Date(NOW - 5 * 60_000).toISOString(), review };
    expect(localReviewLine(ready, NOW)).toBe('api: 3 files, +40 −2 since origin/main · prepared 5m ago');
    expect(localReviewLine({ ...ready, status: 'running' }, NOW)).toBe(
      'Preparing it again… (showing the last one: api: 3 files, +40 −2 since origin/main)',
    );
    expect(localReviewLine({ ...ready, review: { ...review, why: 'no agent for the AI step: stories are by folder' } }, NOW)).toContain(
      '· no agent for the AI step: stories are by folder',
    );
    expect(
      localReviewLine({ status: 'failed', repo: null, repos: [], error: 'Nothing has changed on this branch since origin/main.' }, NOW),
    ).toBe('Couldn’t prepare it: Nothing has changed on this branch since origin/main.');
  });
});

describe('withoutNotes', () => {
  it('takes out the notes you set aside, and is the same review when there are none', () => {
    expect(withoutNotes(review, new Set(['d1'])).drafts.map((d) => d.id)).toEqual(['d2']);
    expect(withoutNotes(review, new Set())).toBe(review);
  });
});

describe('where the Review tab lives', () => {
  it('#/s/<id>/review opens it, and 6 is its key (no other session key has it)', () => {
    expect(parseHash('#/s/abc123/review')).toMatchObject({ sessionId: 'abc123', sessionSubTab: 'review' });
    expect(sessionActionFor({ key: '6' })).toBe('tab-review');
    expect(Object.values(SESSION_KEYS).filter((k) => k.key === '6' && !k.shift)).toHaveLength(1);
  });
});

describe('the review on a page of its own (as the Diff tab’s "Open in browser")', () => {
  it('its address names the session, and only that address is the page', () => {
    expect(sessionReviewPagePath('6628e2385b47')).toBe('/session-review/6628e2385b47');
    expect(parseSessionReviewPage('/session-review/6628e2385b47')).toBe('6628e2385b47');
    expect(parseSessionReviewPage('/session-review/6628e2385b47/')).toBe('6628e2385b47');
    // wd's own pages, the app itself, and anything that isn't an id.
    expect(parseSessionReviewPage('/review/abc123')).toBeNull();
    expect(parseSessionReviewPage('/')).toBeNull();
    expect(parseSessionReviewPage('/session-review/')).toBeNull();
    expect(parseSessionReviewPage('/session-review/a/b')).toBeNull();
    expect(parseSessionReviewPage('/session-review/a%2Fb')).toBeNull();
  });

  it('is headed by your name for the session, else its branch', () => {
    expect(sessionReviewPageTitle({ target: 'straumur', branch: 'feat/warp-setup', title: 'warp setup' })).toEqual({
      name: 'warp setup',
      where: 'straumur / feat/warp-setup',
    });
    expect(sessionReviewPageTitle({ target: 'api', branch: 'feat/x', title: null })).toEqual({ name: 'feat/x', where: 'api' });
  });
});

describe('a local review’s wording (reported: it spoke of GitHub and of comments)', () => {
  it('number 0 is a session’s own changes: its points are notes; a pull request’s are comments', () => {
    expect(isLocalReview({ number: 0 })).toBe(true);
    expect(isLocalReview({ number: 231 })).toBe(false);
    expect(pointsLabel({ number: 0 }, 10)).toBe('10 notes');
    expect(pointsLabel({ number: 0 }, 1)).toBe('1 note');
    expect(pointsLabel({ number: 231 }, 2)).toBe('2 comments');
    expect(pointsLabel({ number: 231 }, 1)).toBe('1 comment');
  });
});

describe('sending notes one at a time (asked for: you may not agree with some)', () => {
  const walk = [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }];

  it('the notes left to send are the ones not sent yet, in order', () => {
    expect(unsentNotes(walk, new Set())).toEqual(walk);
    expect(unsentNotes(walk, new Set(['d2']))).toEqual([{ id: 'd1' }, { id: 'd3' }]);
    expect(unsentNotes(walk, new Set(['d1', 'd2', 'd3']))).toEqual([]);
  });

  it('the button says all of them, then the ones remaining, then that all are sent', () => {
    expect(sendRestLabel(16, 16)).toBe('Send 16 notes to Claude');
    expect(sendRestLabel(1, 1)).toBe('Send 1 note to Claude');
    expect(sendRestLabel(16, 3)).toBe('Send the 3 remaining notes');
    expect(sendRestLabel(16, 1)).toBe('Send the 1 remaining note');
    expect(sendRestLabel(16, 0)).toBe('All 16 notes are sent');
    expect(sendRestLabel(1, 0)).toBe('The note is sent');
  });
});
