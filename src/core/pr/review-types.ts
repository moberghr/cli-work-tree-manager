import type { ThreadCode } from '../api-types.js';

/**
 * A PR's review feedback as work keeps it, whatever host it came from: its
 * threads (resolved or not, with the code each is on), the reviews and the
 * conversation comments, and who you are. Pure; each host's adapter reads
 * its own API into these (GitHub's: core/hosts/github/review.ts).
 */

export interface ReviewComment {
  id: string;
  author: string;
  /** GitHub's authorAssociation: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR,
   *  FIRST_TIME_CONTRIBUTOR, NONE, … */
  association: string;
  body: string;
  url: string;
  createdAt: string;
}
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** The code it's on (its first comment's diff hunk), when it's on a line. */
  code?: ThreadCode | null;
  comments: ReviewComment[];
}

/** The most of a comment kept for the dashboard (a review can paste a log): the rest is on GitHub. */
export const MAX_THREAD_BODY = 8000;
/** The most of a diff hunk kept: its end is what matters, and the view shows only the last lines. */
const MAX_HUNK = 12_000;

/** A thread's code from what GitHub gives (its first comment's hunk, the original line range); null when it has none. Pure. */
export function threadCode(hunk: unknown, originalStartLine: unknown, originalLine: unknown, outdated: boolean): ThreadCode | null {
  if (typeof hunk !== 'string' || !hunk.startsWith('@@')) return null;
  const end = typeof originalLine === 'number' ? originalLine : null;
  const start = typeof originalStartLine === 'number' ? originalStartLine : end;
  const lines = end !== null && start !== null && end >= start ? Math.min(end - start + 1, 200) : 1;
  // Too long: keep the header and the end (the commented line is the last).
  const kept = hunk.length > MAX_HUNK ? `${hunk.split('\n')[0]}\n${hunk.slice(-MAX_HUNK).split('\n').slice(1).join('\n')}` : hunk;
  return { hunk: kept, lines, ...(outdated ? { outdated: true } : {}) };
}

/** A stored thread code as written here; anything else is dropped. Pure. */
export function isThreadCode(v: unknown): v is ThreadCode {
  const c = v as Partial<ThreadCode> | null;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.hunk === 'string' &&
    c.hunk.startsWith('@@') &&
    typeof c.lines === 'number' &&
    c.lines >= 1 &&
    (c.outdated === undefined || typeof c.outdated === 'boolean')
  );
}
export interface ReviewFeedback {
  viewer: string;
  threads: ReviewThread[];
  /** Review summaries (APPROVED / CHANGES_REQUESTED / COMMENTED) with a body. */
  reviews: Array<ReviewComment & { state: string }>;
  /** Conversation (issue) comments on the PR. */
  comments: ReviewComment[];
}
