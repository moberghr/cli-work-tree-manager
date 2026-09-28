import { useMemo, useState } from 'react';
import { setArchived, type SessionSummary } from '../../../api/client.js';
import { openInTerminal } from '../../../api/panes.js';
import type { SessionSubTab } from '../../../state/dashboard-route.js';
import {
  DISPLAY_LABEL,
  defaultSubTab,
  displayStatus,
  isArchived,
  statusBucket,
  type PrLookup,
  type StatusBucket,
} from '../../../state/session-display.js';
import { relativeTime } from '../../../utils/time.js';
import {
  groupRepoNames,
  groupSessionsByTarget,
} from '../../../utils/session-groups.js';
import { DiffStatChip, PrChips } from '../SessionBits.js';

interface Props {
  sessions: SessionSummary[];
  onOpenSession: (id: string, sub?: SessionSubTab) => void;
  onNewWorktree: () => void;
  onDeleteSession: (session: SessionSummary) => void;
  /** Open PRs for a session; rows skip the PR cell without it. */
  prsFor?: PrLookup;
}

type Sort = 'recent' | 'name';
type Filter = 'all' | StatusBucket;
type Grouping = 'none' | 'project';

const GROUPING_KEY = 'work-web:sessions-grouping';
const ARCHIVED_KEY = 'work-web:sessions-show-archived';

function readPref(key: string, on: string): boolean {
  try {
    return localStorage.getItem(key) === on;
  } catch {
    return false;
  }
}
function writePref(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* */ }
}

const FILTER_LABEL: Record<Filter, string> = {
  all: 'all',
  needs: 'needs you',
  working: 'working',
  idle: 'idle',
  stale: 'stale',
};

/**
 * Every session as a dense, scannable table — status, what it's doing,
 * how much it changed, its PR — so you rarely need to open one to know
 * where it stands. Optionally grouped into one section per project; the
 * grouping and "show archived" choices persist in localStorage.
 */
export function SessionsTab({
  sessions,
  onOpenSession,
  onNewWorktree,
  onDeleteSession,
  prsFor,
}: Props) {
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [grouping, setGroupingState] = useState<Grouping>(() =>
    readPref(GROUPING_KEY, 'project') ? 'project' : 'none',
  );
  const [showArchived, setShowArchivedState] = useState(() => readPref(ARCHIVED_KEY, '1'));
  const setGrouping = (g: Grouping) => {
    setGroupingState(g);
    writePref(GROUPING_KEY, g);
  };
  const setShowArchived = (v: boolean) => {
    setShowArchivedState(v);
    writePref(ARCHIVED_KEY, v ? '1' : '0');
  };

  const live = useMemo(() => sessions.filter((s) => !isArchived(s)), [sessions]);
  const archivedCount = sessions.length - live.length;

  const counts = useMemo(() => {
    const c: Record<StatusBucket, number> = { needs: 0, working: 0, idle: 0, stale: 0 };
    for (const s of live) c[statusBucket(displayStatus(s))]++;
    return c;
  }, [live]);

  const filtered = useMemo(() => {
    const pool = showArchived ? sessions : live;
    const matched = pool.filter(
      (s) => filter === 'all' || statusBucket(displayStatus(s)) === filter,
    );
    return [...matched].sort((a, b) => {
      if (sort === 'name') {
        const an = (a.branch || a.target).toLowerCase();
        const bn = (b.branch || b.target).toLowerCase();
        return an.localeCompare(bn);
      }
      return b.lastAccessedAt.localeCompare(a.lastAccessedAt);
    });
  }, [sessions, live, showArchived, sort, filter]);

  const groups = useMemo(
    () =>
      grouping === 'project'
        ? groupSessionsByTarget(filtered, sort === 'name')
        : null,
    [filtered, grouping, sort],
  );

  const renderTable = (list: SessionSummary[]) => (
    <table className="wd-session-table">
      <thead>
        <tr>
          <th className="wd-st-col-status">Status</th>
          <th>Session</th>
          <th className="wd-st-col-summary">Summary</th>
          <th className="wd-st-col-changes">Changes</th>
          <th className="wd-st-col-pr">PR</th>
          <th className="wd-st-col-when">Last active</th>
          <th className="wd-st-col-actions"><span className="wd-visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {list.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            prs={prsFor?.(s) ?? []}
            onOpen={() => onOpenSession(s.id, defaultSubTab(s))}
            onDelete={() => onDeleteSession(s)}
          />
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="wd-dash-tab-pane wd-tab-sessions">
      <header className="wd-tab-header">
        <h1>
          Sessions{' '}
          <span className="wd-tab-header-muted">
            ({counts.needs} need you · {counts.working} working · {counts.idle} idle · {counts.stale} stale)
          </span>
        </h1>
        <div className="wd-tab-controls">
          <label>
            Filter{' '}
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
            >
              {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
                <option key={f} value={f}>{FILTER_LABEL[f]}</option>
              ))}
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
          <label className="wd-tab-check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />{' '}
            Show archived{archivedCount > 0 ? ` (${archivedCount})` : ''}
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
            {renderTable(g.sessions)}
          </section>
        ))}
        </div>
      ) : (
        <div className="wd-session-table-wrap">{renderTable(filtered)}</div>
      )}
    </div>
  );
}

interface RowProps {
  session: SessionSummary;
  prs: ReturnType<PrLookup>;
  onOpen: () => void;
  onDelete: () => void;
}

function SessionRow({ session: s, prs, onOpen, onDelete }: RowProps) {
  const kind = displayStatus(s);
  const archived = isArchived(s);
  const repos = groupRepoNames(s);
  const [busy, setBusy] = useState<null | 'term' | 'archive'>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (what: 'term' | 'archive', fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    fn().then(
      () => setBusy(null),
      (err: Error) => {
        setBusy(null);
        setError(err.message);
      },
    );
  };

  return (
    <tr
      className={
        'wd-session-row' +
        (archived ? ' wd-session-row-archived' : '') +
        (kind === 'needs_input' || kind === 'done' ? ' wd-session-row-unseen' : '')
      }
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => {
        // Ignore keys bubbling up from the row's buttons.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <td className="wd-st-col-status">
        <span className="wd-st-status">
          <span className={`wd-rail-dot wd-rail-dot-${kind}`} aria-hidden />
          <span className="wd-st-label">{DISPLAY_LABEL[kind]}</span>
        </span>
      </td>
      <td className="wd-st-session">
        <span className="wd-st-branch" title={s.branch}>{s.branch || '(base)'}</span>
        <span className="wd-st-target">
          {s.target}
          {s.isGroup && (
            <span
              className="wd-session-group-kind wd-session-group-kind-hint"
              title={repos.length ? `Multi-repo group: ${repos.join(', ')}` : 'Multi-repo group'}
            >
              group
            </span>
          )}
          {archived && <span className="wd-archived-pill">archived</span>}
        </span>
      </td>
      <td className="wd-st-col-summary">
        <span className="wd-st-summary" title={s.attention?.summary}>
          {s.attention?.summary ?? ''}
        </span>
      </td>
      <td className="wd-st-col-changes">
        <DiffStatChip session={s} />
        {!!s.diffStat?.files && (
          <span className="wd-st-files"> · {s.diffStat.files} file{s.diffStat.files === 1 ? '' : 's'}</span>
        )}
      </td>
      <td className="wd-st-col-pr">
        <PrChips prs={prs} link />
      </td>
      <td className="wd-st-col-when">
        {relativeTime(s.attention?.updatedAt ?? s.lastAccessedAt)}
      </td>
      <td className="wd-st-col-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="wd-row-action"
          disabled={busy !== null}
          title={error ?? 'Open in a Windows Terminal tab (work attach)'}
          onClick={() => run('term', () => openInTerminal(s.id))}
        >
          {busy === 'term' ? 'Opening…' : 'Terminal ↗'}
        </button>
        <button
          type="button"
          className="wd-row-action"
          disabled={busy !== null}
          title={archived ? 'Bring it back to the rail and inbox' : 'Stop its Claude, keep worktree, branch and conversation'}
          onClick={() => run('archive', () => setArchived(s.id, !archived))}
        >
          {busy === 'archive' ? (archived ? 'Restoring…' : 'Archiving…') : archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          type="button"
          className="wd-row-action wd-row-action-danger"
          title="Delete session…"
          aria-label={`Delete session ${s.target}/${s.branch}`}
          onClick={onDelete}
        >
          <TrashIcon />
        </button>
        {error && <span className="wd-row-error" role="alert">{error}</span>}
      </td>
    </tr>
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
