import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSessions, markSessionSeen, reportAssistantView, type NotifyEvent, type SessionSummary } from '../api/client.js';
import { showNotify, usePresence } from '../hooks/use-presence.js';
import { coalesce } from '../utils/coalesce.js';
import { compareAttention, needsAttention } from '../../../core/attention.js';
import { InboxTab } from '../components/Dashboard/tabs/InboxTab.js';
import { TodayTab } from '../components/Dashboard/tabs/TodayTab.js';
import { CleanupTab } from '../components/Dashboard/tabs/CleanupTab.js';
import { fetchPrs, type PrInfo } from '../api/panes.js';
import { isArchived, prsForSession, railSessions, type PrLookup } from '../state/session-display.js';
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
import { jiraPrompt, prPrompt } from '../state/start-prompts.js';
import { ReviewQueueBar } from '../components/Dashboard/ReviewQueueBar.js';
import { AssistantPanel } from '../components/Dashboard/AssistantPanel.js';
import { nextInQueue, queuePosition, startQueue, type ReviewQueue } from '../state/review-queue.js';
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
  today: 'Today',
  cleanup: 'Clean up',
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
    prompt?: string;
  } | null>(null);

  // The Ctrl+K assistant. Mounted from the first open, then only hidden.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMounted, setAssistantMounted] = useState(false);
  const toggleAssistant = useCallback(() => {
    setAssistantMounted(true);
    setAssistantOpen((o) => !o);
  }, []);
  useEffect(() => {
    // Capture phase, so it works from inside a terminal too (xterm would
    // otherwise take the key).
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        toggleAssistant();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleAssistant]);

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

  // Fetch + auto-refresh sessions. SSE bumps `refreshKey` on activity; the
  // refetch is coalesced (see utils/coalesce.ts) so a burst of events — one
  // every 250 ms while any Claude writes — costs one fetch, not one each.
  const refetch = useMemo(
    () =>
      coalesce(
        () =>
          fetchSessions().then(
            (data) => {
              setSessions(data);
              setError(null); // a later success clears an earlier failure
            },
            (err: Error) => setError(err.message),
          ),
        400,
      ),
    [],
  );
  useEffect(() => () => refetch.cancel(), [refetch]);
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) {
      // The first load is immediate.
      firstLoad.current = false;
      fetchSessions().then(setSessions, (err: Error) => setError(err.message));
      return;
    }
    refetch.trigger();
  }, [refreshKey, refetch]);

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
  // The one session whose diff should open on "Last turn" (set when it is
  // opened to review finished work: the queue, or its inbox row).
  const [lastTurnFor, setLastTurnFor] = useState<string | null>(null);
  const openSession = useCallback(
    (sessionId: string, sub: SessionSubTab = 'diff', opts: { lastTurn?: boolean } = {}) => {
      setLastTurnFor(opts.lastTurn ? sessionId : null);
      // Preserve the current tab as the breadcrumb target.
      navigate({
        tab: route.tab,
        sessionId,
        sessionSubTab: sub,
      });
    },
    [navigate, route.tab],
  );

  // Review queue ("Review all" on the inbox): finished sessions one by one.
  const [reviewQueue, setReviewQueue] = useState<ReviewQueue | null>(null);
  const startReview = useCallback(() => {
    const q = startQueue(sessions);
    if (!q) return;
    setReviewQueue(q);
    openSession(q.ids[0], 'diff', { lastTurn: true });
  }, [sessions, openSession]);
  const reviewNext = useCallback(() => {
    if (!reviewQueue) return;
    const next = nextInQueue(reviewQueue, route.sessionId, sessions);
    if (next) {
      openSession(next, 'diff', { lastTurn: true });
    } else {
      setReviewQueue(null);
      navigate({ ...DEFAULT_ROUTE, tab: 'inbox' });
    }
  }, [reviewQueue, route.sessionId, sessions, openSession, navigate]);
  const reviewNextRef = useRef(reviewNext);
  reviewNextRef.current = reviewNext;
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
          d: 'today',
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
        // In the review queue, n is "next in the queue".
        if (reviewQueue && queuePosition(reviewQueue, route.sessionId) !== null) {
          e.preventDefault();
          reviewNextRef.current();
          return;
        }
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
      // j / k — move down/up through the rail, in the order it shows them:
      // the current sessions (stable order), plus the selected older one it
      // keeps pinned. (Walking all sessions by recency jumped to rows the
      // rail doesn't show, archived ones included.)
      if (e.key === 'j' || e.key === 'k') {
        const { current, older } = railSessions(sessions);
        const sorted = [...current, ...older.filter((s) => s.id === route.sessionId)];
        if (sorted.length === 0) return;
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
  }, [goTab, openSession, route.sessionId, sessions, modalOpen, reviewQueue]);

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

  // Tell the assistant what is on screen while it is open (its prompt hook
  // adds this to every message), whenever the view changes.
  const assistantSeeing = activeSession
    ? `${activeSession.target} · ${activeSession.branch} (${route.sessionSubTab})`
    : `the ${TAB_LABEL[route.tab]} tab`;
  useEffect(() => {
    if (!assistantOpen) return;
    const view = route.sessionId
      ? { tab: 'session', sub: route.sessionSubTab, sessionId: route.sessionId }
      : { tab: route.tab };
    void reportAssistantView(view).catch(() => {});
  }, [assistantOpen, route.tab, route.sessionId, route.sessionSubTab]);

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
    const position = reviewQueue ? queuePosition(reviewQueue, activeSession.id) : null;
    body = (
      <>
      {reviewQueue && position !== null && (
        <ReviewQueueBar
          position={position}
          total={reviewQueue.ids.length}
          onNext={reviewNext}
          onStop={() => setReviewQueue(null)}
        />
      )}
      <SessionDetail
        startOnLastTurn={lastTurnFor === activeSession.id}
        onOpenSession={(id) => openSession(id)}
        session={activeSession}
        subTab={route.sessionSubTab}
        onSelectSubTab={setSubTab}
        onBack={backFromSession}
        backLabel={TAB_LABEL[route.tab]}
        onDelete={() => setDeleting(activeSession)}
        prs={prsFor(activeSession)}
        onShipped={backFromSession}
      />
      </>
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
        body = <InboxTab sessions={sessions} onOpenSession={openSession} prsFor={prsFor} onReviewAll={startReview} />;
        break;
      case 'today':
        body = <TodayTab onOpenSession={openSession} />;
        break;
      case 'cleanup':
        body = <CleanupTab onOpenSession={(id) => openSession(id)} />;
        break;
      case 'sessions':
        body = (
          <SessionsTab
            sessions={sessions}
            onOpenSession={openSession}
            onNewWorktree={() => openNew(null)}
            onDeleteSession={setDeleting}
            onCleanUp={() => goTab('cleanup')}
            prsFor={prsFor}
          />
        );
        break;
      case 'prs':
        body = (
          <PrsTab
            onPick={(pr) =>
              openNew({ target: pr.repoAlias, branch: pr.branch, prompt: prPrompt(pr) })
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
                prompt: jiraPrompt(issue),
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
        onAssistant={toggleAssistant}
        assistantOpen={assistantOpen}
      >
        {body}
      </DashboardLayout>
      {assistantMounted && (
        <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} seeing={assistantSeeing} />
      )}
      {newOpen && (
        <NewWorktreeModal
          initial={newInitial ?? undefined}
          onCreated={(id, result) => {
            setNewOpen(false);
            setNewInitial(null);
            // Started with a prompt: watch it begin in its terminal.
            openSession(id, result?.started === 'started' ? 'term' : 'diff');
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
