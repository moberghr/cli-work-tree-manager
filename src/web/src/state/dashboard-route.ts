/**
 * URL-hash routing for the dashboard.
 *
 * Routes:
 *   `#/sessions` (or empty hash)     → Sessions tab (landing)
 *   `#/inbox`                         → Inbox: sessions that need you, in order
 *   `#/today`                         → Today: what each session did (digest)
 *   `#/cleanup`                       → Clean up: worktrees that can go (from Sessions)
 *   `#/prs`                           → PRs tab
 *   `#/jira`                          → Jira tab
 *   `#/tasks`                         → Tasks tab
 *   `#/s/<sessionId>`                → Session detail (default: diff sub-tab)
 *   `#/s/<sessionId>/diff`           → Session detail · diff
 *   `#/s/<sessionId>/term`           → Session detail · terminal
 *   `#/s/<sessionId>/comments`       → Session detail · comments
 *
 * `wd`'s deep-link target (`/diff/<hash>`) lands on `ReviewApp`, not
 * here — those scope-hashes are a separate addressing space (the
 * scope-routes /api/scopes hash) and the SPA branches on
 * `/api/context` returning `{mode:'review'}` to pick `ReviewApp`.
 */

export type DashboardTab = 'inbox' | 'today' | 'sessions' | 'cleanup' | 'prs' | 'jira' | 'tasks';
export type SessionSubTab = 'chat' | 'diff' | 'term' | 'comments' | 'timeline';

export interface DashboardRoute {
  tab: DashboardTab;
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

const TAB_RE = /^#\/(inbox|today|sessions|cleanup|prs|jira|tasks)\/?$/;
const SESSION_RE = /^#\/s\/([^/]+)(?:\/(chat|diff|term|comments|timeline))?\/?$/;

export function parseHash(hash: string): DashboardRoute {
  if (!hash || hash === '#' || hash === '#/') return DEFAULT_ROUTE;
  const session = hash.match(SESSION_RE);
  if (session) {
    // A session opens on its terminal unless the link says otherwise.
    const sub = (session[2] as SessionSubTab | undefined) ?? 'term';
    return {
      // Keep the "tab" carrier so breadcrumb knows where to go back to;
      // default to sessions when entering a session URL cold.
      tab: 'sessions',
      sessionId: decodeURIComponent(session[1]),
      sessionSubTab: sub,
    };
  }
  const tab = hash.match(TAB_RE);
  if (tab) {
    return {
      tab: tab[1] as DashboardTab,
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
  } catch { /* storage blocked — resume is a convenience */ }
}
