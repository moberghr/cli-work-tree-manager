import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSessions, type SessionSummary } from '../api/client.js';
import { useSse } from '../api/events.js';
import { DashboardLayout } from '../components/Dashboard/DashboardLayout.js';
import { SessionsTab } from '../components/Dashboard/tabs/SessionsTab.js';
import { PrsTab } from '../components/Dashboard/tabs/PrsTab.js';
import { JiraTab } from '../components/Dashboard/tabs/JiraTab.js';
import {
  TasksTab,
  taskSlug,
} from '../components/Dashboard/tabs/TasksTab.js';
import { SessionDetail } from '../components/Dashboard/SessionDetail.js';
import { NewWorktreeModal } from '../components/Sidebar/NewWorktreeModal.js';
import {
  DEFAULT_ROUTE,
  parseHash,
  toHash,
  type DashboardRoute,
  type DashboardTab,
  type SessionSubTab,
} from '../state/dashboard-route.js';

const TAB_LABEL: Record<DashboardTab, string> = {
  sessions: 'Sessions',
  prs: 'PRs',
  jira: 'Jira',
  tasks: 'Tasks',
};

/**
 * Dashboard root. Reads/writes the URL hash for routing, fetches the
 * cross-cutting sessions list once (refreshed via SSE), and renders the
 * appropriate tab or session-detail view inside `DashboardLayout`.
 *
 * This is the `work web` direct-load view. `wd`'s `/diff/<hash>` opens
 * `ReviewApp` instead (the bare reviewer) — different shell entirely.
 */
export function DashboardApp() {
  const [route, setRoute] = useState<DashboardRoute>(() =>
    parseHash(window.location.hash),
  );
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Modal state — opened from any tab's "create worktree from this thing"
  // action. The initial values pre-fill the form for PR/Jira/Task picks.
  const [newOpen, setNewOpen] = useState(false);
  const [newInitial, setNewInitial] = useState<{
    target?: string;
    branch?: string;
    base?: string;
    jiraKey?: string;
  } | null>(null);

  // Sync route ↔ URL hash. Listen to back/forward; push when we navigate.
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: DashboardRoute) => {
    const targetHash = toHash(next);
    if (window.location.hash === targetHash) return;
    window.location.hash = targetHash;
    // hashchange listener will pick this up and call setRoute; setting
    // state here too keeps the UI immediate.
    setRoute(next);
  }, []);

  // Fetch + auto-refresh sessions. SSE bumps `refreshKey` on activity.
  useEffect(() => {
    let cancelled = false;
    fetchSessions().then(
      (data) => {
        if (!cancelled) setSessions(data);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useSse('/events', {
    events: {
      'sessions-changed': () => setRefreshKey((n) => n + 1),
      'comments-changed': () => setRefreshKey((n) => n + 1),
    },
  });

  // -- Navigation handlers --------------------------------------------------
  const goTab = useCallback(
    (tab: DashboardTab) => {
      navigate({ tab, sessionId: null, sessionSubTab: 'diff' });
    },
    [navigate],
  );
  const openSession = useCallback(
    (sessionId: string) => {
      // Preserve the current tab as the breadcrumb target.
      navigate({
        tab: route.tab,
        sessionId,
        sessionSubTab: 'diff',
      });
    },
    [navigate, route.tab],
  );
  const setSubTab = useCallback(
    (sub: SessionSubTab) => {
      if (!route.sessionId) return;
      navigate({ ...route, sessionSubTab: sub });
    },
    [navigate, route],
  );
  const backFromSession = useCallback(() => {
    navigate({ tab: route.tab, sessionId: null, sessionSubTab: 'diff' });
  }, [navigate, route.tab]);
  const goHome = useCallback(() => goTab('sessions'), [goTab]);

  // Modal helpers — each tab passes its onPick handler that calls one of
  // these to open the modal with a sensible prefill.
  const openNew = useCallback(
    (initial: typeof newInitial = null) => {
      setNewInitial(initial);
      setNewOpen(true);
    },
    [],
  );

  // Keyboard shortcuts. `g s/p/j/t` chord for tabs (gmail/github style);
  // `j/k` walks the rail. Ignore when typing in an input.
  useEffect(() => {
    let pendingG = false;
    let pendingGTimer: ReturnType<typeof setTimeout> | null = null;
    const inField = () => {
      const el = document.activeElement;
      return !!el && (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        (el as HTMLElement).isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inField()) return;
      if (pendingG) {
        pendingG = false;
        if (pendingGTimer) clearTimeout(pendingGTimer);
        const map: Record<string, DashboardTab> = {
          s: 'sessions',
          p: 'prs',
          j: 'jira',
          t: 'tasks',
        };
        if (map[e.key]) {
          e.preventDefault();
          goTab(map[e.key]);
          return;
        }
      }
      if (e.key === 'g') {
        pendingG = true;
        pendingGTimer = setTimeout(() => { pendingG = false; }, 750);
        return;
      }
      // j / k — move down/up through the sorted sessions list.
      if (e.key === 'j' || e.key === 'k') {
        if (sessions.length === 0) return;
        const sorted = [...sessions].sort((a, b) =>
          b.lastAccessedAt.localeCompare(a.lastAccessedAt),
        );
        const currentIdx = route.sessionId
          ? sorted.findIndex((s) => s.id === route.sessionId)
          : -1;
        const delta = e.key === 'j' ? 1 : -1;
        const nextIdx = Math.max(
          0,
          Math.min(sorted.length - 1, currentIdx + delta),
        );
        const next = sorted[nextIdx];
        if (next) {
          e.preventDefault();
          openSession(next.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (pendingGTimer) clearTimeout(pendingGTimer);
    };
  }, [goTab, openSession, route.sessionId, sessions]);

  // Set of Jira keys that already have a worktree, for the Jira tab's
  // "already-has-worktree" badge.
  const sessionJiraKeys = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) if (s.jiraKey) set.add(s.jiraKey);
    return set;
  }, [sessions]);

  // Current session (if route points at one).
  const activeSession = route.sessionId
    ? sessions.find((s) => s.id === route.sessionId) ?? null
    : null;

  const currentScopeLabel = activeSession
    ? `${activeSession.target}/${activeSession.branch}`
    : undefined;

  // -- Render --------------------------------------------------------------
  let body: React.ReactNode;
  if (error && sessions.length === 0) {
    body = <div className="wd-tab-error">{error}</div>;
  } else if (activeSession) {
    body = (
      <SessionDetail
        session={activeSession}
        subTab={route.sessionSubTab}
        onSelectSubTab={setSubTab}
        onBack={backFromSession}
        backLabel={TAB_LABEL[route.tab]}
      />
    );
  } else if (route.sessionId) {
    // Routed to a session that doesn't exist (yet?). Show a placeholder
    // rather than dropping the user back to Sessions.
    body = (
      <div className="wd-tab-empty">
        Session not found. It may have been removed.
        <br />
        <button
          type="button"
          className="wd-btn-secondary"
          onClick={backFromSession}
        >
          Back to {TAB_LABEL[route.tab]}
        </button>
      </div>
    );
  } else {
    switch (route.tab) {
      case 'sessions':
        body = (
          <SessionsTab
            sessions={sessions}
            onOpenSession={openSession}
            onNewWorktree={() => openNew(null)}
          />
        );
        break;
      case 'prs':
        body = (
          <PrsTab
            onPick={(pr) =>
              openNew({ target: pr.repoAlias, branch: pr.branch })
            }
          />
        );
        break;
      case 'jira':
        body = (
          <JiraTab
            onPick={(issue) =>
              openNew({
                branch: `feat/${issue.key}`,
                jiraKey: issue.key,
              })
            }
            sessionJiraKeys={sessionJiraKeys}
          />
        );
        break;
      case 'tasks':
        body = (
          <TasksTab
            onPick={(t) => openNew({ branch: 'todo/' + taskSlug(t.text) })}
          />
        );
        break;
    }
  }

  return (
    <>
      <DashboardLayout
        route={route}
        sessions={sessions}
        currentScopeLabel={currentScopeLabel}
        onSelectTab={goTab}
        onSelectSession={openSession}
        onHome={goHome}
        onNewWorktree={() => openNew(null)}
      >
        {body}
      </DashboardLayout>
      {newOpen && (
        <NewWorktreeModal
          initial={newInitial ?? undefined}
          onCreated={(id) => {
            setNewOpen(false);
            setNewInitial(null);
            openSession(id);
          }}
          onClose={() => {
            setNewOpen(false);
            setNewInitial(null);
          }}
        />
      )}
    </>
  );
}

export default DashboardApp;
