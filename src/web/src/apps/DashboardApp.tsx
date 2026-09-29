import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSessions, markSessionSeen, type NotifyEvent, type SessionSummary } from '../api/client.js';
import { showNotify, usePresence } from '../hooks/use-presence.js';
import { compareAttention, needsAttention } from '../../../core/attention.js';
import { InboxTab } from '../components/Dashboard/tabs/InboxTab.js';
import { fetchPrs, type PrInfo } from '../api/panes.js';
import { isArchived, prsForSession, type PrLookup } from '../state/session-display.js';
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
import { DeleteSessionModal } from '../components/Dashboard/DeleteSessionModal.js';
import {
  DEFAULT_ROUTE,
  initialHash,
  parseHash,
  saveLastRoute,
  toHash,
  type DashboardRoute,
  type DashboardTab,
  type SessionSubTab,
} from '../state/dashboard-route.js';

const TAB_LABEL: Record<DashboardTab, string> = {
  inbox: 'Inbox',
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
const PR_REFRESH_MS = 120_000;
const PR_MIN_GAP_MS = 60_000;

/** `window.localStorage` itself can throw on access (blocked site data). */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function DashboardApp() {
  // A bare URL (`work web` reopened the browser, or a PC restart) resumes
  // on the last route this browser was on; an explicit hash always wins.
  const [route, setRoute] = useState<DashboardRoute>(() => {
    const hash = initialHash(window.location.hash, safeLocalStorage());
    if (hash !== window.location.hash) window.history.replaceState(null, '', hash);
    return parseHash(hash);
  });
  useEffect(() => saveLastRoute(route, safeLocalStorage()), [route]);
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

  // Session pending delete confirmation (card trash button / detail header).
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);

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

  // Notification discipline: tell the server what this tab shows, and turn
  // its `notify` events into click-to-jump browser notifications.
  usePresence(route.sessionId);
  const notifyTarget = useRef({ sessionId: route.sessionId, open: (_id: string, _sub: SessionSubTab) => {} });
  useSse('/events', {
    events: {
      'sessions-changed': () => setRefreshKey((n) => n + 1),
      'comments-changed': () => setRefreshKey((n) => n + 1),
      notify: (data) =>
        showNotify(data as NotifyEvent, notifyTarget.current.sessionId, (id, kind) =>
          notifyTarget.current.open(id, kind === 'needs_input' ? 'term' : 'diff'),
        ),
    },
  });

  // Open PRs for the rail/table/header badges. Background only — nothing
  // waits on it: every 120 s, plus on session changes at most once a minute
  // (a ship / new branch should show its PR without a reload).
  const [prs, setPrs] = useState<PrInfo[]>([]);
  const [prsFetchedAt, setPrsFetchedAt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setPrsFetchedAt(Date.now());
      fetchPrs().then(
        (r) => { if (!cancelled) setPrs(r.prs ?? []); },
        () => { /* gh missing / offline — badges just stay empty */ },
      );
    };
    load();
    const timer = setInterval(load, PR_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (refreshKey === 0 || Date.now() - prsFetchedAt < PR_MIN_GAP_MS) return;
    setPrsFetchedAt(Date.now());
    fetchPrs().then((r) => setPrs(r.prs ?? []), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const prsFor: PrLookup = useCallback((s) => prsForSession(s, prs), [prs]);

  // -- Navigation handlers --------------------------------------------------
  const goTab = useCallback(
    (tab: DashboardTab) => {
      navigate({ tab, sessionId: null, sessionSubTab: 'diff' });
    },
    [navigate],
  );
  const openSession = useCallback(
    (sessionId: string, sub: SessionSubTab = 'diff') => {
      // Preserve the current tab as the breadcrumb target.
      navigate({
        tab: route.tab,
        sessionId,
        sessionSubTab: sub,
      });
    },
    [navigate, route.tab],
  );
  notifyTarget.current = { sessionId: route.sessionId, open: openSession };
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

  const onSessionDeleted = useCallback(
    (id: string) => {
      setDeleting(null);
      // Drop it locally right away; the SSE-driven refetch confirms.
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setRefreshKey((n) => n + 1);
      if (route.sessionId === id) {
        navigate({ tab: route.tab, sessionId: null, sessionSubTab: 'diff' });
      }
    },
    [navigate, route.sessionId, route.tab],
  );

  const modalOpen = newOpen || deleting !== null;

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
      // Any dialog on screen (Ship, confirm-merge, new worktree, delete…)
      // owns the keyboard: navigating out from under it swapped the Ship
      // panel to another session mid-confirmation.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return;
      // A modal is up — don't navigate out from under it.
      if (modalOpen) return;
      if (pendingG) {
        pendingG = false;
        if (pendingGTimer) clearTimeout(pendingGTimer);
        const map: Record<string, DashboardTab> = {
          i: 'inbox',
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
      // n — jump to the next session that wants you, in inbox order,
      // cycling past the one you're on. Opens it where you'd act on it.
      if (e.key === 'n') {
        const queue = sessions
          .filter((s) => !isArchived(s) && needsAttention(s.attention))
          .sort((a, b) => compareAttention(a.attention, b.attention));
        const next = queue.find((s) => s.id !== route.sessionId) ?? queue[0];
        if (next) {
          e.preventDefault();
          openSession(next.id, next.attention?.state === 'needs_input' ? 'term' : 'diff');
        }
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
  }, [goTab, openSession, route.sessionId, sessions, modalOpen]);

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

  // Opening a session that wanted you counts as having seen it — once per
  // unseen episode (keyed by when it entered that state).
  const seenKey =
    activeSession && needsAttention(activeSession.attention) && activeSession.attention!.state === 'idle'
      ? `${activeSession.id}@${activeSession.attention!.since}`
      : null;
  useEffect(() => {
    if (!seenKey) return;
    void markSessionSeen(seenKey.slice(0, seenKey.indexOf('@'))).catch(() => {});
  }, [seenKey]);

  // Unread count in the browser tab, so a pinned tab shows it at a glance.
  const inboxCount = useMemo(
    () => sessions.filter((s) => !isArchived(s) && needsAttention(s.attention)).length,
    [sessions],
  );
  useEffect(() => {
    document.title = inboxCount > 0 ? `(${inboxCount}) work` : 'work';
  }, [inboxCount]);

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
        onDelete={() => setDeleting(activeSession)}
        prs={prsFor(activeSession)}
        onShipped={backFromSession}
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
      case 'inbox':
        body = <InboxTab sessions={sessions} onOpenSession={openSession} prsFor={prsFor} />;
        break;
      case 'sessions':
        body = (
          <SessionsTab
            sessions={sessions}
            onOpenSession={openSession}
            onNewWorktree={() => openNew(null)}
            onDeleteSession={setDeleting}
            prsFor={prsFor}
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
        inboxCount={inboxCount}
        prsFor={prsFor}
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
      {deleting && (
        <DeleteSessionModal
          session={deleting}
          onDeleted={onSessionDeleted}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

export default DashboardApp;
