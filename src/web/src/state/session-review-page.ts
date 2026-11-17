import type { SessionSummary } from '../api/client.js';

/**
 * A session's own review on a page of its own (`/session-review/<id>`): the Review tab alone, for a browser window
 * beside the app — as the Diff tab's "Open in browser" is for the diff. (`/review/<hash>` is taken: `wd -c`.) Pure.
 */

/** The page's address for a session. */
export function sessionReviewPagePath(sessionId: string): string {
  return `/session-review/${encodeURIComponent(sessionId)}`;
}

/** The session a path is the review page of; null for any other path. */
export function parseSessionReviewPage(pathname: string): string | null {
  const m = pathname.match(/^\/session-review\/([a-zA-Z0-9_-]+)\/?$/);
  return m ? m[1] : null;
}

/** What the page says above the review: your name for the session, else its branch, then where it is. */
export function sessionReviewPageTitle(s: Pick<SessionSummary, 'target' | 'branch' | 'title'>): { name: string; where: string } {
  return { name: s.title || s.branch, where: s.title ? `${s.target} / ${s.branch}` : s.target };
}
