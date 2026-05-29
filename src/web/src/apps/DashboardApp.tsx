import { useEffect, useState } from 'react';
import { fetchSessions, type SessionSummary } from '../api/client.js';
import { useSse } from '../api/events.js';
import { DiffView } from '../components/Diff/DiffView.js';
import { SessionList } from '../components/Sidebar/SessionList.js';

export function DashboardApp() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    parseSelectedFromHash(),
  );

  // Reload counter — bumped when history.json changes upstream.
  const [sessionsKey, setSessionsKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchSessions().then(
      (data) => {
        if (cancelled) return;
        setSessions(data);
      },
      (err: Error) => {
        if (cancelled) return;
        setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionsKey]);

  // Pick up new / removed worktrees in real time.
  useSse('/events', {
    events: {
      'sessions-changed': () => setSessionsKey((n) => n + 1),
    },
  });

  // URL hash sync — `#/sessions/<id>` is the source of truth for selection.
  useEffect(() => {
    const onHash = () => setSelectedId(parseSelectedFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function selectSession(id: string) {
    window.location.hash = `#/sessions/${id}`;
  }

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="wd-web-layout">
      <aside className="wd-web-sidebar">
        <header className="wd-web-sidebar-header">
          <h1>work web</h1>
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
            onSelect={selectSession}
          />
        )}
      </aside>
      <main className="wd-web-main">
        {selected ? (
          <DiffView key={selected.id} session={selected} />
        ) : (
          <EmptyState count={sessions?.length ?? 0} />
        )}
      </main>
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

