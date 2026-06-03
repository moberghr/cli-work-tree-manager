import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { useSse } from '../../api/events.js';
import { DiffView } from '../Diff/DiffView.js';
import { PtyView } from '../Terminal/PtyView.js';
import type { SessionSubTab } from '../../state/dashboard-route.js';
import { relativeTime } from '../../utils/time.js';

interface Props {
  session: SessionSummary;
  subTab: SessionSubTab;
  onSelectSubTab: (sub: SessionSubTab) => void;
  /** Breadcrumb target — caller decides whether to return to Sessions,
   *  PRs, Jira, or Tasks. */
  onBack: () => void;
  backLabel: string;
}

/**
 * Drill-in view for a single session, framed by the dashboard chrome
 * (top nav + rail still visible from `DashboardLayout`). Three sub-tabs:
 *
 *   Diff      — what `wd` shows, but inside the dashboard
 *   Terminal  — embedded Claude PTY (work web only — wd doesn't have one)
 *   Comments  — session comments (review thread)
 *
 * `wd`'s deep-link `/diff/<hash>` route is a *different* view entirely
 * (the bare `ReviewApp`) — this is the dashboard's per-session view,
 * not the bare reviewer. Same data underneath; different chrome.
 */
export function SessionDetail({
  session,
  subTab,
  onSelectSubTab,
  onBack,
  backLabel,
}: Props) {
  return (
    <div className="wd-session-detail">
      <header className="wd-session-detail-header">
        <button
          type="button"
          className="wd-back-link"
          onClick={onBack}
          title={`Back to ${backLabel}`}
        >
          ‹ {backLabel}
        </button>
        <h1>
          <span className="wd-session-detail-target">{session.target}</span>
          <span className="wd-session-detail-sep">·</span>
          <span className="wd-session-detail-branch">{session.branch}</span>
        </h1>
        <span className="wd-tab-header-muted">
          {relativeTime(session.lastAccessedAt)}
        </span>
      </header>
      <nav className="wd-session-subtabs" role="tablist">
        <SubTabButton
          label="Diff"
          active={subTab === 'diff'}
          onClick={() => onSelectSubTab('diff')}
        />
        <SubTabButton
          label="Terminal"
          active={subTab === 'term'}
          onClick={() => onSelectSubTab('term')}
        />
        <SubTabButton
          label="Comments"
          active={subTab === 'comments'}
          badge={session.commentCount}
          onClick={() => onSelectSubTab('comments')}
        />
      </nav>
      <div className="wd-session-subtab-body">
        {subTab === 'diff' && <DiffView session={session} />}
        {subTab === 'term' && <PtyView sessionId={session.id} />}
        {subTab === 'comments' && <SessionComments sessionId={session.id} />}
      </div>
    </div>
  );
}

interface SubTabBtnProps {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}

function SubTabButton({ label, active, onClick, badge }: SubTabBtnProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={'wd-session-subtab' + (active ? ' wd-session-subtab-active' : '')}
      onClick={onClick}
    >
      {label}
      {badge ? <span className="wd-session-subtab-badge">{badge}</span> : null}
    </button>
  );
}

interface SessionCommentsProps {
  sessionId: string;
}

interface SessionComment {
  id: string;
  body: string;
  author?: { kind: string };
  createdAt: string;
  status?: string;
  file?: string;
  line?: number;
}

/** Lightweight read-only comment list for the session detail view.
 *  Uses the existing `/api/sessions/:id/comments` endpoint that the
 *  session-comment-routes module already serves. */
function SessionComments({ sessionId }: SessionCommentsProps) {
  const [comments, setComments] = useState<SessionComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useMemo(
    () => async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/comments`,
        );
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = (await res.json()) as { comments: SessionComment[] };
        setComments(body.comments);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);
  useSse('/events', { events: { 'comments-changed': () => refresh() } });

  if (error) return <div className="wd-tab-error">{error}</div>;
  if (!comments) return <div className="wd-tab-empty">Loading…</div>;
  if (comments.length === 0)
    return <div className="wd-tab-empty">No comments yet.</div>;

  return (
    <ul className="wd-session-comments">
      {comments.map((c) => (
        <li key={c.id} className="wd-session-comment">
          <header className="wd-session-comment-header">
            <span>{c.author?.kind ?? 'user'}</span>
            <span className="wd-tab-header-muted">
              {relativeTime(c.createdAt)}
            </span>
            {c.file && (
              <span className="wd-tab-header-muted">
                {c.file}
                {c.line ? `:${c.line}` : ''}
              </span>
            )}
          </header>
          <p className="wd-session-comment-body">{c.body}</p>
        </li>
      ))}
    </ul>
  );
}
