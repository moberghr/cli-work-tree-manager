import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QuickSwitcher, useQuickSwitcher } from '../components/Dashboard/QuickSwitcher.js';
import { Toast, useToast } from '../components/Dashboard/Toast.js';
import { sessionMenuItems } from '../state/session-menu.js';
import { changeRailSections, fetchHostHealth, fetchRailLayout, placeSession } from '../api/client.js';
import type { HostHealth } from '../../../core/pty/host-health.js';
import { HostHealthBanner } from '../components/Dashboard/HostHealthBanner.js';
import { EMPTY_RAIL_LAYOUT, type PlacePatch, type RailLayout, type SectionOp } from '../../../core/rail/rail-layout.js';
import {
  fetchSessionOrder,
  fetchSessions,
  markSessionSeen,
  reportAssistantView,
  saveSessionOrder,
  type NotifyEvent,
  type SessionSummary,
  setArchived,
  snoozeSession,
  unsnoozeSession,
} from '../api/client.js';
import { showNotify, usePresence } from '../hooks/use-presence.js';
import { coalesce } from '../utils/coalesce.js';
import { compareInbox, needsAttention, wantsYou } from '../../../core/status/attention.js';
import { InboxTab } from '../components/Dashboard/tabs/InboxTab.js';
import { TodayTab } from '../components/Dashboard/tabs/TodayTab.js';
import { CleanupTab } from '../components/Dashboard/tabs/CleanupTab.js';
import { ReposTab } from '../components/Dashboard/tabs/ReposTab.js';
import { fetchProjects, fetchPrs, openInEditor, openInTerminal, type PrInfo } from '../api/panes.js';
import { defaultSubTab, isArchived, prsForSession, railGroups, type PrLookup } from '../state/session-display.js';
import { useSse } from '../api/events.js';
import { DashboardLayout } from '../components/Dashboard/DashboardLayout.js';
import { ActivityIndicator } from '../components/Dashboard/ActivityIndicator.js';
import { SessionsTab } from '../components/Dashboard/tabs/SessionsTab.js';
import { StartTab } from '../components/Dashboard/tabs/StartTab.js';
import { taskSlug } from '../components/Dashboard/tabs/TasksTab.js';
import { TasksPanel } from '../components/Dashboard/TasksPanel.js';
import { NowTodayToggle } from '../components/Dashboard/NowTodayToggle.js';
import { SessionDetail } from '../components/Dashboard/SessionDetail.js';
import { jiraPrompt, prPrompt } from '../state/start-prompts.js';
import { ReviewQueueBar } from '../components/Dashboard/ReviewQueueBar.js';
import { AssistantPanel } from '../components/Dashboard/AssistantPanel.js';
import { TerminalDeck } from '../components/Terminal/TerminalDeck.js';
import { nextInQueue, queuePosition, startQueue, type ReviewQueue } from '../state/review-queue.js';
import { NewWorktreeModal } from '../components/Sidebar/NewWorktreeModal.js';
import { DeleteSessionModal } from '../components/Dashboard/DeleteSessionModal.js';
import { ForkSessionModal } from '../components/Dashboard/ForkSessionModal.js';
import { SnoozeUntilDialog } from '../components/Dashboard/SnoozeUntilDialog.js';
import { BlockedByDialog } from '../components/Dashboard/BlockedBy.js';
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
import { modalOpen as aModalIsOpen } from '../state/modal-open.js';

const TAB_LABEL: Record<DashboardTab, string> = {
  inbox: 'Inbox',
  today: 'Today',
  cleanup: 'Clean up',
  sessions: 'Sessions',
  start: 'Start',
  repos: 'Repos',
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

  // Where the session view wants its terminal drawn (the deck follows it).
  const [termSlot, setTermSlot] = useState<HTMLDivElement | null>(null);

  // The Ctrl+K assistant. Mounted from the first open, then only hidden.
  const [assistantOpen, setAssistantOpen] = useState(false);
  // The top bar's Tasks panel (g t).
  const [tasksOpen, setTasksOpen] = useState(false);
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

  // Ctrl+P: the quick switcher (QuickSwitcher.tsx), from anywhere.
  const { open: switcherOpen, close: closeSwitcher } = useQuickSwitcher();

  // Session pending delete confirmation (card trash button / detail header).
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  // Session being forked (the Fork dialog).
  const [forking, setForking] = useState<SessionSummary | null>(null);
  // Session being snoozed until a time of your choosing.
  const [snoozingUntil, setSnoozingUntil] = useState<SessionSummary | null>(null);
  // Session being marked as waiting on other work.
  const [blocking, setBlocking] = useState<SessionSummary | null>(null);
  const { toast, show: showToast, hide: hideToast } = useToast();
  // A rail row's right-click menu (after Rename): the header's and table's buttons, on the row.
  const sessionMenu = useCallback(
    (s: SessionSummary) =>
      sessionMenuItems(s, {
        setArchived: (x, archived) =>
          void setArchived(x.id, archived).then(
            () => showToast({ text: `${archived ? 'Archived' : 'Restored'} ${x.title ?? x.branch}` }),
            (err: Error) => showToast({ text: err.message, kind: 'error' }),
          ),
        openTerminal: (x) =>
          void openInTerminal(x.id).catch((err: Error) => showToast({ text: `Couldn't open a terminal: ${err.message}`, kind: 'error' })),
        openEditor: (x) =>
          void openInEditor(x.id).catch((err: Error) => showToast({ text: `Couldn't open the editor: ${err.message}`, kind: 'error' })),
        copyBranch: (x) =>
          void navigator.clipboard.writeText(x.branch).then(
            () => showToast({ text: `Copied ${x.branch}` }),
            () => showToast({ text: "Couldn't copy to the clipboard", kind: 'error' }),
          ),
        remove: (x) => setDeleting(x),
        fork: (x) => setForking(x),
        snooze: (x, choice) =>
          void snoozeSession(x, choice).then(
            () => showToast({ text: `Snoozed ${x.title ?? x.branch}` }),
            (err: Error) => showToast({ text: err.message, kind: 'error' }),
          ),
        unsnooze: (x) => void unsnoozeSession(x.id).catch((err: Error) => showToast({ text: err.message, kind: 'error' })),
        snoozeUntil: (x) => setSnoozingUntil(x),
        blockBy: (x) => setBlocking(x),
      }),
    [showToast],
  );

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
    // (Re)connected: whatever changed while the stream was down (work web
    // restarting, the laptop asleep) was never sent — fetch it now.
    onOpen: () => setRefreshKey((n) => n + 1),
    events: {
      'session-order-changed': () => void fetchSessionOrder().then(setSessionOrder, () => {}),
      'rail-changed': () => void fetchRailLayout().then(setRailLayout, () => {}),
      'host-health': (data) => setHostHealth(data as HostHealth),
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
  // Start shows the same list: whether one came yet, and why not (gh missing, an error).
  const [prsLoaded, setPrsLoaded] = useState(false);
  const [prsNote, setPrsNote] = useState<string | null>(null);
  const [prsFetchedAt, setPrsFetchedAt] = useState(0);
  const takePrs = useCallback((r: Awaited<ReturnType<typeof fetchPrs>>) => {
    setPrs(r.prs ?? []);
    setPrsLoaded(true);
    setPrsNote(r.available === false ? 'gh isn’t installed or logged in (gh auth login).' : (r.error ?? null));
  }, []);
  const prsFailed = useCallback((err: Error) => {
    setPrsLoaded(true);
    setPrsNote(err.message);
  }, []);
  // The configured groups' repos, so a group session claims only its own repos' PRs.
  const [groupMembers, setGroupMembers] = useState<Map<string, string[]>>(() => new Map());
  useEffect(() => {
    void fetchProjects().then(
      (p) => setGroupMembers(new Map(p.groups.map((g) => [g.name, g.members ?? []]))),
      () => {},
    );
  }, []);
  const membersOf = useCallback((group: string) => groupMembers.get(group), [groupMembers]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setPrsFetchedAt(Date.now());
      fetchPrs().then(
        (r) => {
          if (!cancelled) takePrs(r);
        },
        (err: Error) => {
          if (!cancelled) prsFailed(err); // badges just stay empty
        },
      );
    };
    load();
    const timer = setInterval(load, PR_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [takePrs, prsFailed]);
  useEffect(() => {
    if (refreshKey === 0 || Date.now() - prsFetchedAt < PR_MIN_GAP_MS) return;
    setPrsFetchedAt(Date.now());
    fetchPrs().then(takePrs, prsFailed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const prsFor: PrLookup = useCallback((s) => prsForSession(s, prs, membersOf), [prs, membersOf]);

  // -- Navigation handlers --------------------------------------------------
  const goTab = useCallback(
    (tab: DashboardTab) => {
      navigate({ tab, sessionId: null, sessionSubTab: 'term' });
    },
    [navigate],
  );
  // The one session whose diff should open on "Last turn" (set when it is
  // opened to review finished work: the queue, or its inbox row).
  const [lastTurnFor, setLastTurnFor] = useState<string | null>(null);
  const openSession = useCallback(
    (sessionId: string, sub: SessionSubTab = 'term', opts: { lastTurn?: boolean } = {}) => {
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

  // The rail's drag order: shared by every window (state.db), applied at once here.
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  useEffect(() => {
    void fetchSessionOrder().then(setSessionOrder, () => {});
  }, []);
  const reorderSessions = useCallback((order: string[]) => {
    setSessionOrder(order);
    void saveSessionOrder(order).catch(() => void fetchSessionOrder().then(setSessionOrder, () => {}));
  }, []);

  // The rail's rows as it shows them, for j/k.
  const railShownRef = useRef<string[]>([]);
  const onRailShownChange = useCallback((ids: string[]) => {
    railShownRef.current = ids;
  }, []);

  // How the PTY host is doing (host-health.ts): a warning when it's slow or not answering.
  const [hostHealth, setHostHealth] = useState<HostHealth | null>(null);
  useEffect(() => {
    void fetchHostHealth().then(setHostHealth, () => {});
  }, []);

  // The rail's pins and sections: every window's (state.db), applied as the server answers.
  const [railLayout, setRailLayout] = useState<RailLayout>(EMPTY_RAIL_LAYOUT);
  useEffect(() => {
    void fetchRailLayout().then(setRailLayout, () => {});
  }, []);
  const placeInRail = useCallback(
    (id: string, patch: PlacePatch) =>
      void placeSession(id, patch).then(setRailLayout, (err: Error) => showToast({ text: err.message, kind: 'error' })),
    [showToast],
  );
  const changeSections = useCallback(
    (op: SectionOp) =>
      changeRailSections(op).then(setRailLayout, (err: Error) => {
        showToast({ text: err.message, kind: 'error' });
        throw err;
      }),
    [showToast],
  );

  // Moving between sessions (rail, j/k) keeps the tab you are on — comparing
  // diffs across sessions stays on the diff; entering from elsewhere lands
  // on the terminal.
  const hopTo = useCallback(
    (sessionId: string) => openSession(sessionId, route.sessionId ? route.sessionSubTab : 'term'),
    [openSession, route.sessionId, route.sessionSubTab],
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
    navigate({ tab: route.tab, sessionId: null, sessionSubTab: 'term' });
  }, [navigate, route.tab]);
  const goHome = useCallback(() => goTab('sessions'), [goTab]);
  // Sessions' two views: Now (the table) and Today (the digest).
  const sessionsView = useCallback((v: 'now' | 'today') => goTab(v === 'now' ? 'sessions' : 'today'), [goTab]);

  // Modal helpers — each tab passes its onPick handler that calls one of
  // these to open the modal with a sensible prefill.
  const openNew = useCallback((initial: typeof newInitial = null) => {
    setNewInitial(initial);
    setNewOpen(true);
  }, []);

  const onSessionDeleted = useCallback(
    (id: string) => {
      setDeleting(null);
      // Drop it locally right away; the SSE-driven refetch confirms.
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setRefreshKey((n) => n + 1);
      if (route.sessionId === id) {
        navigate({ tab: route.tab, sessionId: null, sessionSubTab: 'term' });
      }
    },
    [navigate, route.sessionId, route.tab],
  );

  const modalOpen = newOpen || deleting !== null || forking !== null || snoozingUntil !== null || blocking !== null;

  // Keyboard shortcuts. `g s/p/j/t` chord for tabs (gmail/github style);
  // `j/k` walks the rail. Ignore when typing in an input.
  useEffect(() => {
    let pendingG = false;
    let pendingGTimer: ReturnType<typeof setTimeout> | null = null;
    const inField = () => {
      const el = document.activeElement;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inField()) return;
      // Any dialog on screen (Ship, confirm-merge, new worktree, delete…)
      // owns the keyboard: navigating out from under it swapped the Ship
      // panel to another session mid-confirmation.
      if (aModalIsOpen()) return;
      // A modal is up — don't navigate out from under it.
      if (modalOpen) return;
      if (pendingG) {
        pendingG = false;
        if (pendingGTimer) clearTimeout(pendingGTimer);
        const map: Record<string, DashboardTab> = {
          i: 'inbox',
          d: 'today',
          s: 'sessions',
          w: 'start',
          // Old chords for the PRs and Jira pages: both are on Start.
          p: 'start',
          j: 'start',
        };
        if (e.key === 't') {
          e.preventDefault();
          setTasksOpen((o) => !o);
          return;
        }
        if (map[e.key]) {
          e.preventDefault();
          goTab(map[e.key]);
          return;
        }
      }
      if (e.key === 'g') {
        pendingG = true;
        pendingGTimer = setTimeout(() => {
          pendingG = false;
        }, 750);
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
        const queue = sessions.filter((s) => !isArchived(s) && wantsYou(s)).sort(compareInbox);
        const next = queue.find((s) => s.id !== route.sessionId) ?? queue[0];
        if (next) {
          e.preventDefault();
          openSession(next.id, defaultSubTab(next));
        }
        return;
      }
      // j / k — move down/up through the rail, in the order it shows them
      // (the rail reports its rows: older ones unfolded, headings folded, a
      // search); before it has, the same grouping it starts with. (Walking
      // all sessions by recency jumped to rows the rail doesn't show.)
      if (e.key === 'j' || e.key === 'k') {
        const byId = new Map(sessions.map((s) => [s.id, s]));
        const shown = railShownRef.current.map((id) => byId.get(id)).filter((s): s is SessionSummary => !!s);
        const sorted = shown.length
          ? shown
          : railGroups(sessions, { order: sessionOrder, layout: railLayout, activeId: route.sessionId }).groups.flatMap((g) => g.sessions);
        if (sorted.length === 0) return;
        const currentIdx = route.sessionId ? sorted.findIndex((s) => s.id === route.sessionId) : -1;
        const delta = e.key === 'j' ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(sorted.length - 1, currentIdx + delta));
        const next = sorted[nextIdx];
        if (next) {
          e.preventDefault();
          hopTo(next.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (pendingGTimer) clearTimeout(pendingGTimer);
    };
  }, [goTab, openSession, hopTo, route.sessionId, sessions, sessionOrder, railLayout, modalOpen, reviewQueue]);

  // Current session (if route points at one).
  const activeSession = route.sessionId ? (sessions.find((s) => s.id === route.sessionId) ?? null) : null;

  // Tell the assistant what is on screen while it is open (its prompt hook
  // adds this to every message), whenever the view changes.
  const assistantSeeing = activeSession
    ? `${activeSession.target} · ${activeSession.branch} (${route.sessionSubTab})`
    : `the ${TAB_LABEL[route.tab]} tab`;
  useEffect(() => {
    if (!assistantOpen) return;
    const view = route.sessionId ? { tab: 'session', sub: route.sessionSubTab, sessionId: route.sessionId } : { tab: route.tab };
    void reportAssistantView(view).catch(() => {});
  }, [assistantOpen, route.tab, route.sessionId, route.sessionSubTab]);

  // Opening a session that wanted you counts as having seen it — once per
  // unseen episode (keyed by when it entered that state), and only while
  // you can see it: a minimised or unfocused window left on a session used
  // to clear every "Done" that landed there.
  const looking = useLooking();
  const seenKey =
    activeSession && needsAttention(activeSession.attention) && activeSession.attention!.state === 'idle'
      ? `${activeSession.id}@${activeSession.attention!.since}`
      : null;
  useEffect(() => {
    if (!seenKey || !looking) return;
    void markSessionSeen(seenKey.slice(0, seenKey.indexOf('@'))).catch(() => {});
  }, [seenKey, looking]);

  // Unread count in the browser tab, so a pinned tab shows it at a glance.
  const inboxCount = useMemo(() => sessions.filter((s) => !isArchived(s) && wantsYou(s)).length, [sessions]);
  useEffect(() => {
    document.title = inboxCount > 0 ? `(${inboxCount}) work` : 'work';
  }, [inboxCount]);

  // -- Render --------------------------------------------------------------
  let body: React.ReactNode;
  if (error && sessions.length === 0) {
    body = <div className="wd-tab-error">{error}</div>;
  } else if (activeSession) {
    const position = reviewQueue ? queuePosition(reviewQueue, activeSession.id) : null;
    body = (
      <>
        {reviewQueue && position !== null && (
          <ReviewQueueBar position={position} total={reviewQueue.ids.length} onNext={reviewNext} onStop={() => setReviewQueue(null)} />
        )}
        <SessionDetail
          startOnLastTurn={lastTurnFor === activeSession.id}
          onTermSlot={setTermSlot}
          onOpenSession={(id) => openSession(id)}
          session={activeSession}
          subTab={route.sessionSubTab}
          onSelectSubTab={setSubTab}
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
        <button type="button" className="wd-btn-secondary" onClick={backFromSession}>
          Back to {TAB_LABEL[route.tab]}
        </button>
      </div>
    );
  } else {
    switch (route.tab) {
      case 'inbox':
        body = <InboxTab sessions={sessions} onOpenSession={openSession} onReviewAll={startReview} />;
        break;
      case 'today':
        body = <TodayTab onOpenSession={openSession} viewToggle={<NowTodayToggle value="today" onChange={sessionsView} />} />;
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
            menuFor={sessionMenu}
            layout={railLayout}
            viewToggle={<NowTodayToggle value="now" onChange={sessionsView} />}
          />
        );
        break;
      case 'start':
        body = (
          <StartTab
            sessions={sessions}
            prs={prsLoaded ? prs : null}
            prsNote={prsNote}
            membersOf={membersOf}
            onNewWorktree={() => openNew(null)}
            onPickPr={(pr) => openNew({ target: pr.repoAlias, branch: pr.branch, prompt: prPrompt(pr) })}
            onPickIssue={(issue) => openNew({ branch: `feat/${issue.key}`, jiraKey: issue.key, prompt: jiraPrompt(issue) })}
            onOpenSession={(id) => openSession(id)}
            onManageRepos={() => goTab('repos')}
          />
        );
        break;
      case 'repos':
        body = <ReposTab />;
        break;
    }
  }

  return (
    <>
      <DashboardLayout
        route={route}
        sessions={sessions}
        onSelectTab={goTab}
        onSelectSession={hopTo}
        sessionOrder={sessionOrder}
        onReorderSessions={reorderSessions}
        sessionMenu={sessionMenu}
        railLayout={railLayout}
        onPlaceSession={placeInRail}
        onRailSections={changeSections}
        onRailShownChange={onRailShownChange}
        onHome={goHome}
        onNewWorktree={() => openNew(null)}
        inboxCount={inboxCount}
        prsFor={prsFor}
        onAssistant={toggleAssistant}
        activity={<ActivityIndicator onOpenSession={(id) => openSession(id)} />}
        tasks={<TasksPanel open={tasksOpen} onOpenChange={setTasksOpen} onPick={(t) => openNew({ branch: 'todo/' + taskSlug(t.text) })} />}
        assistantOpen={assistantOpen}
      >
        {body}
      </DashboardLayout>
      <TerminalDeck
        activeId={activeSession && route.sessionSubTab === 'term' ? activeSession.id : null}
        slot={termSlot}
        sessions={sessions}
      />
      {assistantMounted && <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} seeing={assistantSeeing} />}
      {newOpen && (
        <NewWorktreeModal
          initial={newInitial ?? undefined}
          onCreated={(id, _result) => {
            setNewOpen(false);
            setNewInitial(null);
            // A new worktree has no diff yet: land on its terminal.
            openSession(id, 'term');
          }}
          onClose={() => {
            setNewOpen(false);
            setNewInitial(null);
          }}
          onManageRepos={() => {
            setNewOpen(false);
            setNewInitial(null);
            goTab('repos');
          }}
        />
      )}
      <HostHealthBanner health={hostHealth} />
      <Toast toast={toast} onClose={hideToast} />
      {switcherOpen && <QuickSwitcher sessions={sessions} onOpen={(id) => openSession(id)} onClose={closeSwitcher} />}
      {blocking && (
        <BlockedByDialog
          session={blocking}
          sessions={sessions}
          onClose={() => setBlocking(null)}
          onDone={(what) => {
            const x = blocking;
            setBlocking(null);
            showToast({ text: `${x.title ?? x.branch} waits on ${what}` });
          }}
        />
      )}
      {snoozingUntil && (
        <SnoozeUntilDialog
          onClose={() => setSnoozingUntil(null)}
          onPick={(until) => {
            const x = snoozingUntil;
            setSnoozingUntil(null);
            void snoozeSession(x, { until }).then(
              () => showToast({ text: `Snoozed ${x.title ?? x.branch}` }),
              (err: Error) => showToast({ text: err.message, kind: 'error' }),
            );
          }}
        />
      )}
      {forking && (
        <ForkSessionModal
          session={forking}
          sessions={sessions}
          onClose={() => setForking(null)}
          onForked={(id, info) => {
            const from = forking.title ?? forking.branch;
            setForking(null);
            refetch.trigger();
            openSession(id, 'term');
            showToast(
              info.startError
                ? { text: `Forked ${from}, but its Claude didn't start: ${info.startError}`, kind: 'error' }
                : { text: `Forked ${from}${info.summarized ? ', with a summary of the conversation' : ''}` },
            );
          }}
        />
      )}
      {deleting && <DeleteSessionModal session={deleting} onDeleted={onSessionDeleted} onClose={() => setDeleting(null)} />}
    </>
  );
}

export default DashboardApp;

/** The page is visible and has focus: someone is looking at it. */
export function useLooking(): boolean {
  const read = () => typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus());
  const [looking, setLooking] = useState(read);
  useEffect(() => {
    const update = () => setLooking(read());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return looking;
}
