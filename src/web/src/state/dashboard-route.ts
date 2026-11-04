/**
 * URL-hash routing for the dashboard.
 *
 * Routes:
 *   `#/sessions` (or empty hash)     → Sessions tab (landing)
 *   `#/inbox`                         → Inbox: sessions that need you, in order
 *   `#/today`                         → Sessions · Today: what each session did (digest)
 *   `#/cleanup`                       → Clean up: worktrees that can go (from Sessions)
 *   `#/start`                         → Start: new worktree, Jira issues and PRs to start from
 *   `#/prs`, `#/jira`                 → (old) Start, which has both now
 *   `#/tasks`                         → (old) Sessions: Tasks is a panel in the top bar now
 *   `#/s/<sessionId>`                → Session detail (default: terminal sub-tab)
 *   `#/s/<sessionId>/term`           → Session detail · terminal
 *   `#/s/<sessionId>/diff`           → Session detail · diff (comments included)
 *   `#/s/<sessionId>/pr`             → Session detail · its pull requests (stage, checks, review threads)
 *   `#/s/<sessionId>/code`           → Session detail · code (its files, read only)
 *   `#/s/<sessionId>/timeline`       → Session detail · timeline (from its ⋯ menu; no tab of its own)
 *   `#/reviews/<repo>/<n>`           → Reviews · a PR's review, its overview
 *   `#/reviews/<repo>/<n>/story/<k>` → Reviews · its k-th story (1-based; the kinds of change after the stories)
 *   `#/reviews/<repo>/<n>/comments/<k>` → Reviews · its draft comments, the k-th on screen
 *   `#/reviews/<repo>/<n>/files[/<path>]` → Reviews · every file in one scroll (GitHub's Files changed), at a file
 *
 * Old links still open: `…/comments` on the Diff (where comments are now),
 * `…/chat` on the Terminal (the headless chat is gone).
 *
 * `wd`'s deep-link target (`/diff/<hash>`) lands on `ReviewApp`, not
 * here — those scope-hashes are a separate addressing space (the
 * scope-routes /api/scopes hash) and the SPA branches on
 * `/api/context` returning `{mode:'review'}` to pick `ReviewApp`.
 */

export type DashboardTab = 'inbox' | 'today' | 'sessions' | 'cleanup' | 'start' | 'jira' | 'reviews' | 'time' | 'repos' | 'welcome';

/** Pages that no longer exist, and where their links land now. */
const OLD_TAB: Record<string, DashboardTab> = { tasks: 'sessions', prs: 'start' };
export type SessionSubTab = 'diff' | 'term' | 'pr' | 'code' | 'timeline';

/** Sub-tabs that no longer exist, and where their links land now. */
const OLD_SUB_TAB: Record<string, SessionSubTab> = { comments: 'diff', chat: 'term' };

/**
 * The review open on the Reviews tab, and where in it: the overview, a page of the story pager, a comment of the walk,
 * or every file in one scroll (at a file).
 */
export interface ReviewRoute {
  repo: string;
  number: number;
  mode: 'overview' | 'story' | 'comments' | 'files';
  /** 0-based: the story page or the comment (the overview and the files: 0). */
  at: number;
  /** The Files view: the file scrolled to (absent: the top). */
  file?: string;
}

export interface DashboardRoute {
  tab: DashboardTab;
  /** On the Reviews tab: the review open (absent: none, the list). */
  review?: ReviewRoute;
  /** Set when the user has drilled into a specific session. The
   *  session view "overlays" the active tab — breadcrumb returns
   *  to whichever tab the user came from. */
  sessionId: string | null;
  sessionSubTab: SessionSubTab;
}

export const DEFAULT_ROUTE: DashboardRoute = {
  tab: 'sessions',
  sessionId: null,
  sessionSubTab: 'term',
};

const TAB_RE = /^#\/(inbox|today|sessions|cleanup|start|repos|welcome|prs|jira|reviews|time|tasks)\/?$/;
const SESSION_RE = /^#\/s\/([^/]+)(?:\/(chat|diff|term|comments|pr|code|timeline))?\/?$/;
const REVIEW_RE = /^#\/reviews\/([^/]+)\/(\d+)(?:\/(story|comments)\/(\d+))?\/?$/;
const REVIEW_FILES_RE = /^#\/reviews\/([^/]+)\/(\d+)\/files(?:\/([^/]+))?\/?$/;

/** A review's route from its hash, or null. A bad number (0, huge) is the first. */
function parseReview(hash: string): ReviewRoute | null {
  const f = hash.match(REVIEW_FILES_RE);
  if (f) {
    let repo: string;
    let file: string | undefined;
    try {
      repo = decodeURIComponent(f[1]);
      file = f[3] ? decodeURIComponent(f[3]) : undefined;
    } catch {
      return null;
    }
    const number = Number(f[2]);
    if (!repo || !Number.isSafeInteger(number) || number <= 0) return null;
    return { repo, number, mode: 'files', at: 0, ...(file ? { file } : {}) };
  }
  const m = hash.match(REVIEW_RE);
  if (!m) return null;
  let repo: string;
  try {
    repo = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const number = Number(m[2]);
  if (!repo || !Number.isSafeInteger(number) || number <= 0) return null;
  const k = m[4] ? Number(m[4]) : 1;
  const at = Number.isSafeInteger(k) && k >= 1 ? k - 1 : 0;
  return { repo, number, mode: (m[3] as ReviewRoute['mode'] | undefined) ?? 'overview', at: m[3] ? at : 0 };
}

/** A review route's hash. */
export function reviewHash(r: ReviewRoute): string {
  const base = `#/reviews/${encodeURIComponent(r.repo)}/${r.number}`;
  if (r.mode === 'files') return r.file ? `${base}/files/${encodeURIComponent(r.file)}` : `${base}/files`;
  return r.mode === 'overview' ? base : `${base}/${r.mode}/${r.at + 1}`;
}

export function parseHash(hash: string): DashboardRoute {
  if (!hash || hash === '#' || hash === '#/') return DEFAULT_ROUTE;
  const session = hash.match(SESSION_RE);
  if (session) {
    // A session opens on its terminal unless the link says otherwise.
    const sub = session[2] ? (OLD_SUB_TAB[session[2]] ?? (session[2] as SessionSubTab)) : 'term';
    return {
      // Keep the "tab" carrier so breadcrumb knows where to go back to;
      // default to sessions when entering a session URL cold.
      tab: 'sessions',
      sessionId: decodeURIComponent(session[1]),
      sessionSubTab: sub,
    };
  }
  const review = parseReview(hash);
  if (review) return { tab: 'reviews', review, sessionId: null, sessionSubTab: 'term' };
  const tab = hash.match(TAB_RE);
  if (tab) {
    return {
      tab: OLD_TAB[tab[1]] ?? (tab[1] as DashboardTab),
      sessionId: null,
      sessionSubTab: 'term',
    };
  }
  return DEFAULT_ROUTE;
}

export function toHash(route: DashboardRoute): string {
  if (route.sessionId) {
    return `#/s/${encodeURIComponent(route.sessionId)}/${route.sessionSubTab}`;
  }
  if (route.tab === 'reviews' && route.review) return reviewHash(route.review);
  return `#/${route.tab}`;
}

export const LAST_ROUTE_KEY = 'work-web:last-route';

/** Minimal Storage surface, so tests can pass a fake (or a throwing one). */
export type RouteStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The hash the dashboard should open on. An explicit hash always wins; a
 * bare URL (work web reopened the browser, a PC restart) resumes the last
 * route this browser saved, if it still parses to something. Storage that
 * throws (private window, blocked site data) just means "no resume".
 */
export function initialHash(currentHash: string, storage: RouteStorage | null): string {
  if (currentHash && currentHash !== '#' && currentHash !== '#/') return currentHash;
  let saved: string | null;
  try {
    saved = storage?.getItem(LAST_ROUTE_KEY) ?? null;
  } catch {
    return currentHash;
  }
  if (!saved || parseHash(saved) === DEFAULT_ROUTE) return currentHash;
  return saved;
}

export function saveLastRoute(route: DashboardRoute, storage: RouteStorage | null): void {
  try {
    storage?.setItem(LAST_ROUTE_KEY, toHash(route));
  } catch {
    /* storage blocked — resume is a convenience */
  }
}
