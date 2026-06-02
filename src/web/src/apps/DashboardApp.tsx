import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSessions, type SessionSummary } from '../api/client.js';
import { useSse } from '../api/events.js';
import { DiffView } from '../components/Diff/DiffView.js';
import { PtyView } from '../components/Terminal/PtyView.js';
import { SessionList } from '../components/Sidebar/SessionList.js';
import { PrsPane } from '../components/Sidebar/PrsPane.js';
import { TasksPane, taskSlug } from '../components/Sidebar/TasksPane.js';
import { JiraPane, jiraSlug } from '../components/Sidebar/JiraPane.js';
import { NewWorktreeModal } from '../components/Sidebar/NewWorktreeModal.js';
import { markViewed, readAllViewed } from '../state/viewed.js';
import {
  MAX_OPEN_SESSIONS,
  readOpened,
  writeOpened,
} from '../state/opened-sessions.js';

type Tab = 'diff' | 'terminal';

/**
 * Dashboard root. Keeps a window of recently-opened session views mounted
 * (hidden via display:none) so switching between sessions is instant —
 * no WebSocket reconnect, no xterm re-render, no diff refetch. Server-side
 * PTYs and chokidar watchers are already long-lived; this just stops the
 * browser from throwing away its view of them every time the user clicks.
 */
export function DashboardApp() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    parseSelectedFromHash(),
  );

  // Reload counter — bumped when history.json or comment counts change.
  const [sessionsKey, setSessionsKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchSessions().then(
      (data) => { if (!cancelled) setSessions(data); },
      (err: Error) => { if (!cancelled) setError(err.message); },
    );
    return () => { cancelled = true; };
  }, [sessionsKey]);

  useSse('/events', {
    events: {
      'sessions-changed': () => setSessionsKey((n) => n + 1),
      'comments-changed': () => setSessionsKey((n) => n + 1),
    },
  });

  const [viewed, setViewed] = useState(() => readAllViewed());

  // New-worktree modal. Initial prefill is set when opened from a PR,
  // Jira issue, or task — empty otherwise.
  const [newOpen, setNewOpen] = useState(false);
  const [newInitial, setNewInitial] = useState<{
    target?: string;
    branch?: string;
    base?: string;
    jiraKey?: string;
  } | null>(null);
  function openNew(initial: typeof newInitial = null) {
    setNewInitial(initial);
    setNewOpen(true);
  }

  // URL hash sync — `#/sessions/<id>` is the source of truth for selection.
  useEffect(() => {
    const onHash = () => setSelectedId(parseSelectedFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selectSession = useCallback((id: string) => {
    window.location.hash = `#/sessions/${id}`;
  }, []);

  /** Drop a session from the Active set. Persists; reload-safe. If the
   *  user closed the currently-selected session, jump to the nearest
   *  remaining one in the open window. */
  const closeSession = useCallback(
    (id: string) => {
      setOpenedIds((prev) => {
        const next = prev.filter((x) => x !== id);
        // If we just closed the active session, navigate to its neighbour.
        if (id === selectedId) {
          const fallback = next[next.length - 1] ?? null;
          if (fallback) {
            window.location.hash = `#/sessions/${fallback}`;
          } else {
            // No sessions left in the open window — clear the hash so
            // the empty state shows.
            history.replaceState(null, '', window.location.pathname);
            setSelectedId(null);
          }
        }
        return next;
      });
    },
    [selectedId],
  );

  // -- Open-set bookkeeping -------------------------------------------------
  //
  // openedIds is the LRU window of sessions whose views are kept mounted.
  // Whenever the user selects a session, we move it to the end (most
  // recent). When the window exceeds MAX_OPEN_SESSIONS, the least recent
  // session falls off — its DiffView + PtyView unmount, its WebSocket
  // closes, and re-opening that session reconnects from scratch (the
  // server-side PTY is still there in the pool, so output replays).
  const [openedIds, setOpenedIds] = useState<string[]>(() => {
    const stored = readOpened();
    if (selectedId && !stored.includes(selectedId)) {
      stored.push(selectedId);
      return stored.slice(-MAX_OPEN_SESSIONS);
    }
    return stored;
  });
  useEffect(() => {
    if (!selectedId) return;
    setOpenedIds((prev) => {
      // Already in the set — leave the order alone. Sessions get pinned
      // to the position they first landed at; switching between them
      // doesn't shuffle the sidebar around under the user's cursor.
      if (prev.includes(selectedId)) return prev;
      const next = [...prev, selectedId];
      return next.slice(-MAX_OPEN_SESSIONS);
    });
  }, [selectedId]);
  // Persist on every change so the Active group survives a reload.
  useEffect(() => {
    writeOpened(openedIds);
  }, [openedIds]);

  // Per-session tab — switching sessions takes you back to whatever tab
  // you were on for THAT session. Defaults to 'diff' for unseen sessions.
  const [tabBySession, setTabBySession] = useState<Record<string, Tab>>({});
  const activeTab: Tab = selectedId
    ? (tabBySession[selectedId] ?? 'diff')
    : 'diff';
  const setActiveTab = useCallback(
    (tab: Tab) => {
      if (!selectedId) return;
      setTabBySession((prev) => ({ ...prev, [selectedId]: tab }));
    },
    [selectedId],
  );

  // Lazy-mount PtyView: don't spawn a Claude PTY for a session just
  // because the user clicked it. Wait until they ask for the Terminal
  // tab. After that the PtyView stays mounted for as long as the
  // session is in the open window.
  const [terminalMounted, setTerminalMounted] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => {
    if (activeTab !== 'terminal' || !selectedId) return;
    setTerminalMounted((prev) => {
      if (prev.has(selectedId)) return prev;
      const next = new Set(prev);
      next.add(selectedId);
      return next;
    });
  }, [activeTab, selectedId]);

  // Drop terminalMounted entries for sessions that fell out of openedIds.
  useEffect(() => {
    setTerminalMounted((prev) => {
      const open = new Set(openedIds);
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (open.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [openedIds]);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  // Mark a session viewed when it opens (drives the unread badge baseline).
  useEffect(() => {
    if (!selected) return;
    markViewed(selected.id, selected.claudeCount ?? 0);
    setViewed(readAllViewed());
  }, [selected?.id, selected?.claudeCount]);

  // -- Keyboard navigation --------------------------------------------------
  //
  // Cmd/Ctrl+1..9 jump to the Nth most-recently-opened session — same
  // muscle memory as browser tabs / tmux windows. Cmd/Ctrl+\ toggles
  // between Diff and Terminal for the current session.
  const recentOrder = useMemo(() => [...openedIds].reverse(), [openedIds]);
  const recentOrderRef = useRef(recentOrder);
  recentOrderRef.current = recentOrder;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const id = recentOrderRef.current[idx];
        if (id) {
          e.preventDefault();
          selectSession(id);
        }
      } else if (e.key === '\\') {
        e.preventDefault();
        setActiveTab(activeTab === 'diff' ? 'terminal' : 'diff');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectSession, setActiveTab, activeTab]);

  // -- Render ---------------------------------------------------------------
  const openSessions = useMemo(() => {
    if (!sessions) return [];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return openedIds.flatMap((id) => {
      const s = byId.get(id);
      return s ? [s] : [];
    });
  }, [sessions, openedIds]);

  return (
    <div className="wd-web-layout">
      <aside className="wd-web-sidebar">
        <header className="wd-web-sidebar-header">
          <div className="wd-web-sidebar-title-row">
            <h1>work web</h1>
            <button
              type="button"
              className="wd-web-sidebar-action"
              onClick={() => openNew(null)}
              title="New worktree"
              aria-label="New worktree"
            >
              +
            </button>
          </div>
          <p>
            {sessions
              ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
              : error
                ? 'failed to load'
                : 'loading…'}
          </p>
        </header>
        {error && <div className="wd-web-error">{error}</div>}
        {sessions && (
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            viewed={viewed}
            activeIds={recentOrder}
            onSelect={selectSession}
            onCloseActive={closeSession}
          />
        )}
        <PrsPane
          onPick={(pr) =>
            openNew({ target: pr.repoAlias, branch: pr.branch })
          }
        />
        <TasksPane
          onPick={(t) =>
            openNew({ branch: 'todo/' + taskSlug(t.text) })
          }
        />
        <JiraPane
          onPick={(issue) =>
            openNew({ branch: jiraSlug(issue), jiraKey: issue.key })
          }
        />
      </aside>
      <main className="wd-web-main">
        {selected ? (
          <div className="wd-web-tabs-wrap">
            <nav className="wd-web-main-tabs">
              <button
                type="button"
                className={
                  'wd-web-main-tab' +
                  (activeTab === 'diff' ? ' wd-web-main-tab-active' : '')
                }
                onClick={() => setActiveTab('diff')}
                title="Diff (Ctrl+\\)"
              >
                Diff
              </button>
              <button
                type="button"
                className={
                  'wd-web-main-tab' +
                  (activeTab === 'terminal' ? ' wd-web-main-tab-active' : '')
                }
                onClick={() => setActiveTab('terminal')}
                title="Terminal (Ctrl+\\)"
              >
                Terminal
              </button>
            </nav>
            <div className="wd-web-tab-body">
              {/*
                Render every opened session's views; hide all but the
                currently-active one. Mounting persists xterm + WebSocket
                + diff state across switches so navigation is instant.
              */}
              {openSessions.map((s) => {
                const isVisible = s.id === selectedId;
                const sessionTab = tabBySession[s.id] ?? 'diff';
                return (
                  <div
                    key={s.id}
                    className="wd-web-session-pane"
                    style={{ display: isVisible ? 'flex' : 'none' }}
                  >
                    <div
                      className="wd-web-pane-slot"
                      style={{
                        display: sessionTab === 'diff' ? 'block' : 'none',
                      }}
                    >
                      <DiffView session={s} />
                    </div>
                    {terminalMounted.has(s.id) && (
                      <div
                        className="wd-web-pane-slot"
                        style={{
                          display:
                            sessionTab === 'terminal' ? 'flex' : 'none',
                        }}
                      >
                        <PtyView sessionId={s.id} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <EmptyState count={sessions?.length ?? 0} />
        )}
      </main>
      {newOpen && (
        <NewWorktreeModal
          initial={newInitial ?? undefined}
          onCreated={(id) => {
            setNewOpen(false);
            setNewInitial(null);
            // SSE will refresh the list; navigate immediately.
            window.location.hash = `#/sessions/${id}`;
          }}
          onClose={() => {
            setNewOpen(false);
            setNewInitial(null);
          }}
        />
      )}
    </div>
  );
}

function parseSelectedFromHash(): string | null {
  const m = window.location.hash.match(/^#\/sessions\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function EmptyState({ count }: { count: number }) {
  return (
    <div className="wd-web-empty">
      {count === 0
        ? 'No worktree sessions yet. Run `work tree <target> <branch>` in any terminal.'
        : 'Select a session in the sidebar.'}
    </div>
  );
}
