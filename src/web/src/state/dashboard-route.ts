/**
 * URL-hash routing for the dashboard.
 *
 * Routes:
 *   `#/sessions` (or empty hash)     → Sessions tab (landing)
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

export type DashboardTab = 'sessions' | 'prs' | 'jira' | 'tasks';
export type SessionSubTab = 'diff' | 'term' | 'comments';

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
  sessionSubTab: 'diff',
};

const TAB_RE = /^#\/(sessions|prs|jira|tasks)\/?$/;
const SESSION_RE = /^#\/s\/([^/]+)(?:\/(diff|term|comments))?\/?$/;

export function parseHash(hash: string): DashboardRoute {
  if (!hash || hash === '#' || hash === '#/') return DEFAULT_ROUTE;
  const session = hash.match(SESSION_RE);
  if (session) {
    const sub = (session[2] as SessionSubTab | undefined) ?? 'diff';
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
      sessionSubTab: 'diff',
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
