import { useEffect, useMemo, useState } from 'react';
import { setArchived, type SessionSummary } from '../../api/client.js';
import type { PrInfo } from '../../api/panes.js';
import { isArchived } from '../../state/session-display.js';
import { ContextChip, DiffStatChip, OverlapChip, PrChips, StatusLine } from './SessionBits.js';
import { ShipPanel } from './ShipPanel.js';
import { DevChip } from './DevChip.js';
import { CiStrip } from './CiStrip.js';
import { useSse } from '../../api/events.js';
import { DiffView } from '../Diff/DiffView.js';
import { PtyView } from '../Terminal/PtyView.js';
import type { SessionSubTab } from '../../state/dashboard-route.js';
import { relativeTime } from '../../utils/time.js';
import { TrashIcon } from './tabs/SessionsTab.js';
import { openInTerminal } from '../../api/panes.js';

interface Props {
  session: SessionSummary;
  subTab: SessionSubTab;
  onSelectSubTab: (sub: SessionSubTab) => void;
  /** Breadcrumb target — caller decides whether to return to Sessions,
   *  PRs, Jira, or Tasks. */
  onBack: () => void;
  backLabel: string;
  /** Opens the delete-session confirmation. */
  onDelete: () => void;
  /** Open PRs for this session (PRs pane data). */
  prs?: PrInfo[];
  /** A merge from the Ship panel went through (session now archived). */
  onShipped?: () => void;
  /** Open the diff on "Last turn" (review queue / a finished session). */
  startOnLastTurn?: boolean;
  /** Open another session (the overlap warning links to it). */
  onOpenSession?: (id: string) => void;
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
  onDelete,
  prs = [],
  onShipped,
  startOnLastTurn = false,
  onOpenSession,
}: Props) {
  // Which session the Ship panel was opened FOR: it closes itself when the
  // detail switches to another session (j/k, a notification click), so a
  // merge confirmation can never end up acting on a different session.
  const [shipFor, setShipFor] = useState<string | null>(null);
  const shipOpen = shipFor === session.id;
  const setShipOpen = (open: boolean) => setShipFor(open ? session.id : null);
  const archived = isArchived(session);
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
        {archived && <span className="wd-archived-pill">archived</span>}
        <OpenTerminalButton key={`term-${session.id}`} sessionId={session.id} />
        <button
          type="button"
          className="wd-session-detail-btn wd-session-detail-ship"
          onClick={() => setShipOpen(true)}
          title="Push, open a PR, or merge"
        >
          Ship ▾
        </button>
        <ArchiveButton key={`archive-${session.id}`} sessionId={session.id} archived={archived} />
        <button
          type="button"
          className="wd-session-detail-delete"
          onClick={onDelete}
          title="Delete this session (and its worktree)"
        >
          <TrashIcon /> Delete
        </button>
      </header>
      <div className="wd-session-strip">
        <StatusLine session={session} />
        <DiffStatChip session={session} />
        <OverlapChip session={session} onOpen={onOpenSession} />
        <ContextChip session={session} />
        <PrChips prs={prs} link />
        <DevChip sessionId={session.id} />
        {!session.attention && (
          <span className="wd-tab-header-muted">entered {relativeTime(session.lastAccessedAt)}</span>
        )}
      </div>
      <CiStrip sessionId={session.id} isGroup={session.isGroup} />
      {shipOpen && (
        <ShipPanel
          key={session.id}
          session={session}
          onClose={() => setShipOpen(false)}
          onMerged={() => {
            setShipOpen(false);
            onShipped?.();
          }}
        />
      )}
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
        {subTab === 'diff' && <DiffView session={session} startOnLastTurn={startOnLastTurn} />}
        {subTab === 'term' && <PtyView sessionId={session.id} />}
        {subTab === 'comments' && <SessionComments sessionId={session.id} />}
      </div>
    </div>
  );
}

/** Opens the session in a real Windows Terminal tab (`work attach`), sharing
 *  the same Claude as the Terminal sub-tab — both are views on the PTY
 *  host's session. */
function OpenTerminalButton({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const onClick = () => {
    setState('busy');
    openInTerminal(sessionId).then(
      () => setState('idle'),
      (err: Error) => {
        setState('error');
        setError(err.message);
      },
    );
  };
  return (
    <button
      type="button"
      className="wd-session-detail-action"
      onClick={onClick}
      disabled={state === 'busy'}
      title={
        state === 'error' && error
          ? error
          : 'Open this session in a Windows Terminal tab (work attach). Same Claude as the Terminal tab.'
      }
    >
      {state === 'busy' ? 'Opening…' : state === 'error' ? 'Open in terminal ⚠' : 'Open in terminal ↗'}
    </button>
  );
}

/** Archive stops the session's Claude but keeps worktree, branch and
 *  conversation; it drops off the rail and inbox until unarchived. */
function ArchiveButton({ sessionId, archived }: { sessionId: string; archived: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onClick = () => {
    setBusy(true);
    setError(null);
    setArchived(sessionId, !archived).then(
      () => setBusy(false),
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };
  return (
    <button
      type="button"
      className="wd-session-detail-btn"
      onClick={onClick}
      disabled={busy}
      title={
        error ??
        (archived
          ? 'Bring it back to the rail and inbox'
          : 'Stop its Claude and hide it; worktree, branch and conversation are kept')
      }
    >
      {busy ? (archived ? 'Restoring…' : 'Archiving…') : archived ? 'Unarchive' : error ? 'Archive ⚠' : 'Archive'}
    </button>
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
