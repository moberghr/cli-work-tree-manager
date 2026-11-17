import { useEffect, useState } from 'react';
import { fetchSessions, type SessionSummary } from '../api/client.js';
import { SessionReviewTab } from '../components/Dashboard/tabs/SessionReviewTab.js';
import { sessionReviewPageTitle } from '../state/session-review-page.js';

/**
 * A session's own review on a page of its own (`/session-review/<id>`, state/session-review-page.ts): the session's
 * Review tab and nothing else, for a browser window beside the app. It is the same review the tab shows (kept by
 * work web per session), so preparing it here shows there too.
 */
export function SessionReviewApp({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessions(true).then(
      (all) => {
        if (cancelled) return;
        const found = all.find((s) => s.id === sessionId);
        if (found) setSession(found);
        else setError('This session is not one of work’s (it may have been removed).');
      },
      (e: Error) => {
        if (!cancelled) setError(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error) return <div className="wd-web-error">{error}</div>;
  if (!session) return <div className="wd-web-empty">Connecting…</div>;
  const title = sessionReviewPageTitle(session);
  return (
    <main className="wd-session-review-page">
      <header className="wd-session-review-page-head">
        <h1>{title.name}</h1>
        <span className="wd-start-note">{title.where} · review of its changes</span>
      </header>
      <SessionReviewTab session={session} ownPage />
    </main>
  );
}
