import { useMemo, useState } from 'react';
import type { SessionSummary } from '../../../api/client.js';
import { relativeTime } from '../../../utils/time.js';
import {
  groupRepoNames,
  groupSessionsByTarget,
} from '../../../utils/session-groups.js';

interface Props {
  sessions: SessionSummary[];
  onOpenSession: (id: string) => void;
  onNewWorktree: () => void;
  onDeleteSession: (session: SessionSummary) => void;
}

type Sort = 'recent' | 'name';
type Filter = 'all' | 'active' | 'idle' | 'stale';
type Grouping = 'none' | 'project';

const GROUPING_KEY = 'work-web:sessions-grouping';

function readGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === 'project' ? 'project' : 'none';
  } catch {
    return 'none';
  }
}

/** Compact, scannable card grid replacing the old left-rail SessionList.
 *  Optionally grouped into one section per project (work target — a repo
 *  alias or a multi-repo group); the choice persists in localStorage. */
export function SessionsTab({
  sessions,
  onOpenSession,
  onNewWorktree,
  onDeleteSession,
}: Props) {
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [grouping, setGroupingState] = useState<Grouping>(readGrouping);
  const setGrouping = (g: Grouping) => {
    setGroupingState(g);
    try { localStorage.setItem(GROUPING_KEY, g); } catch { /* */ }
  };

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

  const groups = useMemo(
    () =>
      grouping === 'project'
        ? groupSessionsByTarget(filtered, sort === 'name')
        : null,
    [filtered, grouping, sort],
  );

  const renderGrid = (list: SessionSummary[]) => (
    <div className="wd-session-grid">
      {list.map((s) => (
        <SessionCard
          key={s.id}
          session={s}
          onOpen={() => onOpenSession(s.id)}
          onDelete={() => onDeleteSession(s)}
        />
      ))}
    </div>
  );

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
            Group{' '}
            <select
              value={grouping}
              onChange={(e) => setGrouping(e.target.value as Grouping)}
            >
              <option value="none">none</option>
              <option value="project">project</option>
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
      ) : groups ? (
        <div className="wd-session-groups">
        {groups.map((g) => (
          <section key={g.key} className="wd-session-group">
            <h2 className="wd-session-group-header">
              <span className="wd-session-group-name">{g.key}</span>
              {g.isGroup && (
                <span
                  className="wd-session-group-kind"
                  title="Multi-repo group"
                >
                  group
                </span>
              )}
              {g.repos.length > 0 && (
                <ul
                  className="wd-session-group-repos"
                  aria-label="Repos in this group"
                >
                  {g.repos.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <span className="wd-tab-header-muted">({g.sessions.length})</span>
            </h2>
            {renderGrid(g.sessions)}
          </section>
        ))}
        </div>
      ) : (
        renderGrid(filtered)
      )}
    </div>
  );
}

interface CardProps {
  session: SessionSummary;
  onOpen: () => void;
  onDelete: () => void;
}

function SessionCard({ session: s, onOpen, onDelete }: CardProps) {
  const repos = groupRepoNames(s);
  // Grouped view lists the repos in the section header; on the card they
  // live in the badge tooltip.
  const kindTitle =
    repos.length > 0
      ? `Multi-repo group: ${repos.join(', ')}`
      : 'Multi-repo group';
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
        // Ignore keys bubbling up from the nested delete button.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <header className="wd-session-card-header">
        <span className={dotClass} aria-hidden />
        <span className="wd-session-card-target" title={s.target}>
          {s.target}
        </span>
        {s.isGroup && (
          <span
            className="wd-session-group-kind wd-session-group-kind-hint"
            title={kindTitle}
            aria-label={kindTitle}
          >
            group
          </span>
        )}
        <button
          type="button"
          className="wd-session-card-delete"
          title="Delete session…"
          aria-label={`Delete session ${s.target}/${s.branch}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <TrashIcon />
        </button>
      </header>
      <div className="wd-session-card-branch" title={s.branch}>
        {s.branch}
      </div>
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

export function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.5 1.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25V3h-3V1.75ZM11 3V1.75A1.75 1.75 0 0 0 9.25 0h-2.5A1.75 1.75 0 0 0 5 1.75V3H2.75a.75.75 0 0 0 0 1.5h.58l.66 9.23A1.75 1.75 0 0 0 5.73 15.5h4.54a1.75 1.75 0 0 0 1.74-1.77l.66-9.23h.58a.75.75 0 0 0 0-1.5H11Zm-6.17 1.5h6.34l-.65 9.12a.25.25 0 0 1-.25.23H5.73a.25.25 0 0 1-.25-.23L4.83 4.5Z"
      />
    </svg>
  );
}
