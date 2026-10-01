import { useEffect, useMemo, useState } from 'react';
import { useArchivePending } from '../../../api/archive-pending.js';
import { searchConversations, setArchived, type ConversationHit, type SessionSummary } from '../../../api/client.js';
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
import { AGE_LABEL, ageBucket, lastActiveAt, sessionMatches, statusHint, type AgeBucket } from '../../../state/session-display.js';
import {
  groupRepoNames,
  groupSessionsByTarget,
} from '../../../utils/session-groups.js';
import { ContextChip, DiffStatChip, OverlapChip, PrChips } from '../SessionBits.js';

interface Props {
  sessions: SessionSummary[];
  onOpenSession: (id: string, sub?: SessionSubTab) => void;
  onNewWorktree: () => void;
  onDeleteSession: (session: SessionSummary) => void;
  /** Open PRs for a session; rows skip the PR cell without it. */
  prsFor?: PrLookup;
  /** Open the Clean up view. */
  onCleanUp?: () => void;
}

type Sort = 'recent' | 'name';
type Filter = 'all' | StatusBucket;
type Grouping = 'age' | 'project' | 'none';

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
  onCleanUp,
}: Props) {
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [grouping, setGroupingState] = useState<Grouping>(() => {
    try {
      const v = localStorage.getItem(GROUPING_KEY);
      return v === 'project' || v === 'none' ? v : 'age';
    } catch {
      return 'age';
    }
  });
  // "Older" starts folded: with hundreds of worktrees it is most of the list.
  const [showOlder, setShowOlder] = useState(false);
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
      (s) => (filter === 'all' || statusBucket(displayStatus(s)) === filter) && sessionMatches(s, query),
    );
    return [...matched].sort((a, b) => {
      if (sort === 'name') {
        const an = (a.branch || a.target).toLowerCase();
        const bn = (b.branch || b.target).toLowerCase();
        return an.localeCompare(bn);
      }
      return lastActiveAt(b).localeCompare(lastActiveAt(a));
    });
  }, [sessions, live, showArchived, sort, filter, query]);

  const groups = useMemo(
    () =>
      grouping === 'project'
        ? groupSessionsByTarget(filtered, sort === 'name')
        : null,
    [filtered, grouping, sort],
  );
  const ages = useMemo(() => {
    if (grouping !== 'age') return null;
    const by: Record<AgeBucket, SessionSummary[]> = { now: [], week: [], older: [] };
    for (const s of filtered) by[ageBucket(s)].push(s);
    return (Object.keys(by) as AgeBucket[]).map((k) => ({ key: k, sessions: by[k] })).filter((g) => g.sessions.length > 0);
  }, [filtered, grouping]);

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
          <input
            className="wd-tab-search"
            type="search"
            placeholder="Search branch, repo, folder…"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
          />
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
              <option value="age">age</option>
              <option value="project">project</option>
              <option value="none">none</option>
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
          {onCleanUp && (
            <button type="button" className="wd-btn-secondary" onClick={onCleanUp} title="Find worktrees that are safe to remove">
              Clean up…
            </button>
          )}
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
      ) : ages ? (
        <div className="wd-session-groups">
          {ages.map((g) => {
            // A search shows its matches, the older ones too.
            const folded = g.key === 'older' && !showOlder && query.trim() === '';
            return (
              <section key={g.key} className={`wd-session-group wd-session-age wd-session-age-${g.key}`}>
                <h2 className="wd-session-group-header">
                  <span className="wd-session-group-name">{AGE_LABEL[g.key]}</span>
                  <span className="wd-tab-header-muted">({g.sessions.length})</span>
                  {g.key === 'older' && (
                    <button type="button" className="wd-row-action wd-session-age-toggle" onClick={() => setShowOlder((v) => !v)}>
                      {folded ? 'Show' : 'Hide'}
                    </button>
                  )}
                  {g.key !== 'now' && onCleanUp && (
                    <button type="button" className="wd-row-action" onClick={onCleanUp} title="Find worktrees that are safe to remove">
                      Clean up…
                    </button>
                  )}
                </h2>
                {!folded && renderTable(g.sessions)}
              </section>
            );
          })}
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
      <ConversationHits query={query} onOpen={(id) => onOpenSession(id, 'diff')} />
    </div>
  );
}

/**
 * While searching: sessions whose conversation mentions it — "what did we do
 * about the encryption keys?" — live ones and archived ones (Restore), with
 * the matching lines. work keeps the conversations (conversation-store.ts),
 * so this reaches back past Claude Code's own 30 days.
 */
function ConversationHits({ query, onOpen }: { query: string; onOpen: (id: string) => void }) {
  const [hits, setHits] = useState<ConversationHit[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void searchConversations(q).then((h) => live && setHits(h), () => live && setHits([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);
  if (hits.length === 0) return null;
  return (
    <section className="wd-session-group wd-archive-hits">
      <h2 className="wd-session-group-title">In conversations ({hits.length})</h2>
      <ul className="wd-archive-hit-list">
        {hits.map((h) => (
          <li key={h.sessionId} className="wd-archive-hit">
            <div className="wd-archive-hit-head">
              <button type="button" className="wd-link-button" onClick={() => onOpen(h.sessionId)}>
                {h.target} · {h.branch}
              </button>
              <span className="wd-tab-header-muted">
                {h.archived && h.archivedAt
                  ? ` archived ${relativeTime(h.archivedAt)}${h.worktreeRemoved ? ' · folder removed' : ''}`
                  : h.lastAt
                    ? ` ${relativeTime(h.lastAt)}`
                    : ''}
              </span>
              {h.archived && (
              <button
                type="button"
                className="wd-row-action"
                disabled={restoring !== null}
                title={h.worktreeRemoved ? 'Recreate its worktree from the branch and continue the conversation' : 'Bring it back'}
                onClick={() => {
                  setRestoring(h.sessionId);
                  void setArchived(h.sessionId, false).finally(() => setRestoring(null));
                }}
              >
                {restoring === h.sessionId ? 'Restoring…' : 'Restore'}
              </button>
              )}
            </div>
            {h.snippets.map((sn, i) => (
              <p key={i} className="wd-archive-hit-snippet">
                <span className="wd-tab-header-muted">{sn.role === 'you' ? 'You' : sn.role === 'summary' ? 'Summary' : 'Claude'}:</span> {sn.text}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
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
  const archiving = useArchivePending(s.id); // also one started elsewhere (the session header)

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
        <span className="wd-st-status" title={statusHint(kind)}>
          <span className={`wd-rail-dot wd-rail-dot-${kind}`} aria-hidden />
          <span className="wd-st-label">{DISPLAY_LABEL[kind]}</span>
        </span>
      </td>
      <td className="wd-st-session">
        <span className="wd-st-branch" title={s.branch}>{s.branch || '(base)'}</span>
        {s.title && <span className="wd-st-title" title={s.title}>{s.title}</span>}
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
          {archived && (
            <span
              className="wd-archived-pill"
              title={
                s.archive
                  ? s.archive.worktreeRemoved
                    ? 'Worktree removed; its branch and the conversation are kept. Restore recreates it.'
                    : `Worktree kept: ${s.archive.keptBecause ?? 'it has work in it'}`
                  : 'Archived'
              }
            >
              {s.archive?.worktreeRemoved ? 'archived · folder removed' : 'archived'}
            </span>
          )}
        </span>
      </td>
      <td className="wd-st-col-summary">
        {(() => {
          // An archived session: what it was about (its archive's summary / first prompt).
          const text = s.attention?.summary ?? (archived ? (s.archive?.written ?? s.archive?.lastSummary ?? s.archive?.prompts[0]) : undefined) ?? '';
          return (
            <span className="wd-st-summary" title={text}>
              {text}
            </span>
          );
        })()}
      </td>
      <td className="wd-st-col-changes">
        <DiffStatChip session={s} />
        {!!s.diffStat?.files && (
          <span className="wd-st-files"> · {s.diffStat.files} file{s.diffStat.files === 1 ? '' : 's'}</span>
        )}
        {s.overlaps?.length ? (
          <div className="wd-st-overlap">
            <OverlapChip session={s} />
          </div>
        ) : null}
      </td>
      <td className="wd-st-col-pr">
        <PrChips prs={prs} link />
      </td>
      <td className="wd-st-col-when">
        {relativeTime(lastActiveAt(s))}
        {s.context && (
          <div className="wd-st-context">
            <ContextChip session={s} />
          </div>
        )}
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
          disabled={busy !== null || archiving !== undefined}
          title={
            archived
              ? s.archive?.worktreeRemoved
                ? 'Recreate its worktree from the branch and continue the conversation'
                : 'Bring it back to the rail and inbox'
              : 'Stop its Claude and keep the conversation and a summary; the worktree is removed if nothing would be lost (the branch stays)'
          }
          onClick={() => run('archive', () => setArchived(s.id, !archived))}
        >
          {archiving !== undefined ? (archiving ? 'Archiving…' : 'Restoring…') : archived ? 'Restore' : 'Archive'}
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
