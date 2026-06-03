import { useMemo, useState } from 'react';
import type { SessionSummary } from '../../../api/client.js';
import { relativeTime } from '../../../utils/time.js';

interface Props {
  sessions: SessionSummary[];
  onOpenSession: (id: string) => void;
  onNewWorktree: () => void;
}

type Sort = 'recent' | 'name';
type Filter = 'all' | 'active' | 'idle' | 'stale';

/** Compact, scannable card grid replacing the old left-rail SessionList. */
export function SessionsTab({ sessions, onOpenSession, onNewWorktree }: Props) {
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const c = { all: sessions.length, active: 0, idle: 0, stale: 0 };
    for (const s of sessions) {
      if (s.activityState === 'active') c.active++;
      else if (s.activityState === 'open') c.idle++;
      else c.stale++;
    }
    return c;
  }, [sessions]);

  const filtered = useMemo(() => {
    const matched = sessions.filter((s) => {
      if (filter === 'all') return true;
      if (filter === 'active') return s.activityState === 'active';
      if (filter === 'idle') return s.activityState === 'open';
      return s.activityState !== 'active' && s.activityState !== 'open';
    });
    return [...matched].sort((a, b) => {
      if (sort === 'name') {
        const an = (a.branch || a.target).toLowerCase();
        const bn = (b.branch || b.target).toLowerCase();
        return an.localeCompare(bn);
      }
      return b.lastAccessedAt.localeCompare(a.lastAccessedAt);
    });
  }, [sessions, sort, filter]);

  return (
    <div className="wd-dash-tab-pane wd-tab-sessions">
      <header className="wd-tab-header">
        <h1>
          Sessions{' '}
          <span className="wd-tab-header-muted">
            ({counts.active} active · {counts.idle} idle · {counts.stale} stale)
          </span>
        </h1>
        <div className="wd-tab-controls">
          <label>
            Filter{' '}
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
            >
              <option value="all">all</option>
              <option value="active">active</option>
              <option value="idle">idle</option>
              <option value="stale">stale</option>
            </select>
          </label>
          <label>
            Sort{' '}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
            >
              <option value="recent">recent</option>
              <option value="name">name</option>
            </select>
          </label>
          <button
            type="button"
            className="wd-btn-primary"
            onClick={onNewWorktree}
          >
            + New worktree
          </button>
        </div>
      </header>
      {filtered.length === 0 ? (
        <div className="wd-tab-empty">
          {sessions.length === 0
            ? 'No worktrees yet. Run `work tree <target> <branch>` in any terminal, or click "New worktree" above.'
            : 'No sessions match the current filter.'}
        </div>
      ) : (
        <div className="wd-session-grid">
          {filtered.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onOpen={() => onOpenSession(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  session: SessionSummary;
  onOpen: () => void;
}

function SessionCard({ session: s, onOpen }: CardProps) {
  const dotClass =
    s.activityState === 'active'
      ? 'wd-card-dot wd-card-dot-active'
      : s.activityState === 'open'
        ? 'wd-card-dot wd-card-dot-open'
        : 'wd-card-dot wd-card-dot-stale';
  return (
    <article
      className="wd-session-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <header className="wd-session-card-header">
        <span className={dotClass} aria-hidden />
        <span className="wd-session-card-target">{s.target}</span>
        <span className="wd-session-card-sep">/</span>
        <span className="wd-session-card-branch">{s.branch}</span>
      </header>
      <div className="wd-session-card-meta">
        <span>{relativeTime(s.lastAccessedAt)}</span>
        {!!s.commentCount && s.commentCount > 0 && (
          <span title={`${s.commentCount} comments`}>
            💬 {s.commentCount}
          </span>
        )}
        {!!s.draftCount && s.draftCount > 0 && (
          <span title={`${s.draftCount} draft comments`}>
            ✎ {s.draftCount}
          </span>
        )}
        {!!s.pendingForClaudeCount && s.pendingForClaudeCount > 0 && (
          <span title={`${s.pendingForClaudeCount} pending for Claude`}>
            →{s.pendingForClaudeCount}
          </span>
        )}
      </div>
    </article>
  );
}
