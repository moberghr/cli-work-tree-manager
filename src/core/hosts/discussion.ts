import type { PrDiscussionReviewWire } from '../api-types.js';

/**
 * PURE — what every host's `discussion` read keeps of a PR's existing
 * discussion (#64): a comment's text cut at a length (a review can paste a
 * log; the rest is on the host), at most so many comments a thread. Each
 * adapter reads its own API into `PrDiscussion` (types.ts) with these.
 */

/** The most of one comment kept. */
export const MAX_DISCUSSION_BODY = 4000;
/** The most comments kept of one thread (its first ones: the point, then the answers). */
export const MAX_THREAD_COMMENTS = 50;

/** A comment's text, cut at `MAX_DISCUSSION_BODY` with a note that the rest is on the host. */
export function discussionBody(body: unknown): string {
  const text = typeof body === 'string' ? body : '';
  return text.length > MAX_DISCUSSION_BODY ? `${text.slice(0, MAX_DISCUSSION_BODY)}\n\n… (cut: the rest is on the host)` : text;
}

/** GitHub's review states in work's words; null for one that isn't a verdict anyone sees (PENDING: a draft). */
export function reviewStateOf(state: unknown): PrDiscussionReviewWire['state'] | null {
  switch (typeof state === 'string' ? state.toUpperCase() : '') {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'COMMENTED':
      return 'commented';
    case 'DISMISSED':
      return 'dismissed';
    default:
      return null;
  }
}
