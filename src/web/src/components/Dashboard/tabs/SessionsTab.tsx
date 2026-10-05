import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_RAIL_LAYOUT, groupRail, type RailGroup, type RailLayout } from '../../../../../core/rail/rail-layout.js';
import { BulkBar, type BulkActions } from './BulkBar.js';
import { bulkSummary, runBulk } from '../../../state/bulk.js';
import { StatusIcon } from '../StatusIcon.js';
import { useArchivePending } from '../../../api/archive-pending.js';
import {
  placeSession,
  searchConversations,
  sendPromptToSession,
  setArchived,
  snoozeSession,
  type ConversationHit,
  type SessionSummary,
} from '../../../api/client.js';
import { removeWorktree } from '../../../api/panes.js';
import type { SessionSubTab } from '../../../state/dashboard-route.js';
import {
  DISPLAY_LABEL,
  defaultSubTab,
  displayStatus,
  isArchived,
  statusBucket,
  CONTEXT_WARN,
  type StatusBucket,
} from '../../../state/session-display.js';
import { relativeTime } from '../../../utils/time.js';
import { AGE_LABEL, ageBucket, lastActiveAt, sessionMatches, statusHint, type AgeBucket } from '../../../state/session-display.js';
import { groupRepoNames, groupSessionsByTarget } from '../../../utils/session-groups.js';
import { DiffStatChip, overlapTitle } from '../SessionBits.js';
import { RowMenu, type MenuItem } from '../RowMenu.js';

interface Props {
  sessions: SessionSummary[];
  onOpenSession: (id: string, sub?: SessionSubTab) => void;
  onNewWorktree: () => void;
  onDeleteSession: (session: SessionSummary) => void;
  /** A row's ⋯ (and right-click) menu: the rail's. Without it, Archive / Restore and Delete. */
  menuFor?: (s: SessionSummary) => MenuItem[];
  /** Open the Clean up view. */
  onCleanUp?: () => void;
  /** The bulk bar's calls (tests swap them). */
  bulk?: BulkActions;
  /** The rail's pins and sections: shown on the rows, a filter and a grouping, and the bulk bar's Pin / Move to. */
  layout?: RailLayout;
  /** "Now / Today" beside the title: Sessions' two views. */
  viewToggle?: React.ReactNode;
  /** Archived sessions are fetched only while shown: told when "Show archived" is on (and off when the table goes). */
  onShowArchived?: (on: boolean) => void;
}

/** The bulk bar's calls: the same as the one-session buttons. Archive and delete never force: one with work waiting is refused, and listed. */
export const defaultBulk: BulkActions = {
  archive: (s) => setArchived(s.id, true, () => false),
  restore: (s) => setArchived(s.id, false, () => false),
  snooze: (s, choice) => snoozeSession(s, choice),
  send: (s, text) => sendPromptToSession(s.id, text),
  remove: (s) => removeWorktree(s.id, {}),
  place: (s, patch) => placeSession(s.id, patch),
};

type Sort = 'recent' | 'name';
type Filter = 'all' | StatusBucket;
type Grouping = 'age' | 'project' | 'section' | 'none';
/** The rail filter: everything, the pinned, one section (its id), or in none. */
type RailFilter = 'any' | 'pinned' | 'none' | `section:${string}`;

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
  try {
    localStorage.setItem(key, value);
  } catch {
    /* */
  }
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
  layout,
  sessions,
  onOpenSession,
  onNewWorktree,
  onDeleteSession,
  menuFor,
  onCleanUp,
  bulk = defaultBulk,
  viewToggle,
  onShowArchived,
}: Props) {
  // Ticked rows, for the bulk bar (kept across filters; acted on as they are now).
  // The checkboxes show only while selecting (View ▾ → Select several).
  const [selecting, setSelectingState] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const setSelecting = (on: boolean) => {
    setSelectingState(on);
    if (!on) setPicked(new Set());
  };
  const [rowMenu, setRowMenu] = useState<{ s: SessionSummary; x: number; y: number } | null>(null);
  const menuItems = (x: SessionSummary): MenuItem[] =>
    menuFor
      ? menuFor(x)
      : [
          isArchived(x)
            ? { label: 'Restore', run: () => void setArchived(x.id, false).catch(() => {}) }
            : { label: 'Archive', run: () => void setArchived(x.id, true).catch(() => {}) },
          { label: 'Delete…', run: () => onDeleteSession(x), danger: true, separated: true },
        ];
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [bulkOutcome, setBulkOutcome] = useState<string | null>(null);
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // Ticked AND shown: a filter that hides a ticked row takes it out of what
  // the bar acts on (it would act on sessions you can't see); the bar says so.
  const tickedAll = sessions.filter((s) => picked.has(s.id));
  const runBulkAction = (verb: string, act: (s: SessionSummary) => Promise<unknown>, which: SessionSummary[]) => {
    const byId = new Map(which.map((s) => [s.id, s]));
    setBulkOutcome(null);
    setBulkBusy(`${verb} 0/${which.length}…`);
    void runBulk([...byId.keys()], (id) => act(byId.get(id)!), {
      onProgress: (done, total) => setBulkBusy(`${verb} ${done}/${total}…`),
    }).then((results) => {
      setBulkBusy(null);
      setBulkOutcome(bulkSummary(verb, results, (id) => byId.get(id)?.branch ?? id));
      // What worked is done with; what was refused stays ticked, to try again or look at.
      setPicked(new Set(results.filter((r) => !r.ok).map((r) => r.id)));
    });
  };
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const [railFilter, setRailFilter] = useState<RailFilter>('any');
  const rail = layout ?? EMPTY_RAIL_LAYOUT;
  // Its group in the rail, by the rail's own rule (pinned wins; a removed section is none).
  const railGroupOf = useMemo(() => {
    const m = new Map<string, RailGroup<SessionSummary>>();
    // As the rail: archived sessions are in none of its groups.
    for (const g of groupRail(
      sessions.filter((s) => !isArchived(s)),
      rail,
    ))
      for (const s of g.sessions) m.set(s.id, g);
    return m;
  }, [sessions, rail]);
  const inRail = useCallback(
    (s: SessionSummary): boolean => {
      if (railFilter === 'any') return true;
      const g = railGroupOf.get(s.id);
      if (railFilter === 'pinned') return g?.key === 'pinned';
      if (railFilter === 'none') return !g || g.key === 'rest';
      return g?.key === railFilter;
    },
    [railFilter, railGroupOf],
  );
  const [query, setQuery] = useState('');
  const [grouping, setGroupingState] = useState<Grouping>(() => {
    try {
      const v = localStorage.getItem(GROUPING_KEY);
      return v === 'project' || v === 'none' || v === 'section' ? v : 'age';
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

  useEffect(() => {
    onShowArchived?.(showArchived);
    return () => onShowArchived?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callback is the app's, stable in effect; only the toggle matters
  }, [showArchived]);
  const live = useMemo(() => sessions.filter((s) => !isArchived(s)), [sessions]);
  const archivedCount = sessions.length - live.length;

  const counts = useMemo(() => {
    const c: Record<AgeBucket, number> = { now: 0, week: 0, older: 0 };
    for (const s of live) c[ageBucket(s)]++;
    return c;
  }, [live]);

  const filtered = useMemo(() => {
    const pool = showArchived ? sessions : live;
    const matched = pool.filter(
      (s) => (filter === 'all' || statusBucket(displayStatus(s)) === filter) && inRail(s) && sessionMatches(s, query),
    );
    return [...matched].sort((a, b) => {
      if (sort === 'name') {
        const an = (a.branch || a.target).toLowerCase();
        const bn = (b.branch || b.target).toLowerCase();
        return an.localeCompare(bn);
      }
      return lastActiveAt(b).localeCompare(lastActiveAt(a));
    });
  }, [sessions, live, showArchived, sort, filter, query, inRail]);

  const selected = filtered.filter((s) => picked.has(s.id));
  const hiddenTicked = tickedAll.length - selected.length;
  // A ticked session that is gone (deleted elsewhere) leaves the selection.
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id));
    setPicked((prev) => ([...prev].every((id) => ids.has(id)) ? prev : new Set([...prev].filter((id) => ids.has(id)))));
  }, [sessions]);

  const groups = useMemo(
    () => (grouping === 'project' ? groupSessionsByTarget(filtered, sort === 'name') : null),
    [filtered, grouping, sort],
  );
  // Grouped as the rail is: Pinned, your sections, Other.
  const railGroups = useMemo(() => {
    if (grouping !== 'section') return null;
    const groups = groupRail(
      filtered.filter((s) => !isArchived(s)),
      rail,
    ).filter((g) => g.sessions.length > 0);
    const archived = filtered.filter((s) => isArchived(s));
    return archived.length ? [...groups, { key: 'archived', title: 'Archived', sessions: archived }] : groups;
  }, [filtered, grouping, rail]);
  const ages = useMemo(() => {
    if (grouping !== 'age') return null;
    const by: Record<AgeBucket, SessionSummary[]> = { now: [], week: [], older: [] };
    for (const s of filtered) by[ageBucket(s)].push(s);
    return (Object.keys(by) as AgeBucket[]).map((k) => ({ key: k, sessions: by[k] })).filter((g) => g.sessions.length > 0);
  }, [filtered, grouping]);

  const railTagFor = (s: SessionSummary): string | null => {
    const g = railGroupOf.get(s.id);
    return g?.key === 'pinned' ? '📌' : g?.sectionId ? g.title : null;
  };

  const renderTable = (list: SessionSummary[]) => (
    <table className={'wd-session-table' + (selecting ? ' wd-session-table-selecting' : '')}>
      <thead>
        <tr>
          {selecting && (
            <th className="wd-st-col-pick">
              <input
                type="checkbox"
                aria-label="Select all shown"
                checked={list.length > 0 && list.every((s) => picked.has(s.id))}
                onChange={(e) => {
                  const on = e.target.checked;
                  setPicked((prev) => {
                    const next = new Set(prev);
                    for (const s of list) {
                      if (on) next.add(s.id);
                      else next.delete(s.id);
                    }
                    return next;
                  });
                }}
              />
            </th>
          )}
          <th className="wd-st-col-status">Status</th>
          <th>Session</th>
          <th className="wd-st-col-summary">Summary</th>
          <th className="wd-st-col-changes">Changes</th>
          <th className="wd-st-col-when">Active</th>
          <th className="wd-st-col-more">
            <span className="wd-visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {list.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            onOpen={() => onOpenSession(s.id, defaultSubTab(s))}
            onMenu={(x, y) => setRowMenu({ s, x, y })}
            selecting={selecting}
            picked={picked.has(s.id)}
            onPick={(on) => toggle(s.id, on)}
            railTag={railTagFor(s)}
          />
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="wd-dash-tab-pane wd-tab-sessions">
      <header className="wd-tab-header">
        <h1>
          Sessions {viewToggle}{' '}
          <span className="wd-tab-header-muted">
            {[
              counts.now ? `${counts.now} now` : '',
              counts.week ? `${counts.week} this week` : '',
              counts.older ? `${counts.older} older` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </h1>
        <div className="wd-tab-controls">
          <input
            className="wd-tab-search"
            type="search"
            placeholder="Search branch, repo, words…"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
          />
          <ViewMenu>
            <label>
              Show
              <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Status filter">
                {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
                  <option key={f} value={f}>
                    {FILTER_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            {(rail.sections.length > 0 || Object.keys(rail.places).length > 0) && (
              <label>
                Rail
                <select value={railFilter} onChange={(e) => setRailFilter(e.target.value as RailFilter)} aria-label="Rail filter">
                  <option value="any">any</option>
                  <option value="pinned">pinned</option>
                  {rail.sections.map((sec) => (
                    <option key={sec.id} value={`section:${sec.id}`}>
                      {sec.name}
                    </option>
                  ))}
                  <option value="none">in no section</option>
                </select>
              </label>
            )}
            <label>
              Group
              <select value={grouping} onChange={(e) => setGrouping(e.target.value as Grouping)} aria-label="Group by">
                <option value="age">age</option>
                <option value="project">project</option>
                <option value="section">rail section</option>
                <option value="none">none</option>
              </select>
            </label>
            <label>
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
                <option value="recent">recent</option>
                <option value="name">name</option>
              </select>
            </label>
            <label className="wd-tab-check">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
              {archivedCount > 0 ? ` (${archivedCount})` : ''}
            </label>
            <label className="wd-tab-check">
              <input type="checkbox" checked={selecting} onChange={(e) => setSelecting(e.target.checked)} /> Select several
            </label>
          </ViewMenu>
          {onCleanUp && (
            <button type="button" className="wd-link-button" onClick={onCleanUp} title="Find worktrees that are safe to remove">
              Clean up
            </button>
          )}
          <button type="button" className="wd-btn-primary" onClick={onNewWorktree}>
            New
          </button>
        </div>
      </header>
      {(selected.length > 0 || bulkBusy) && (
        <BulkBar
          selected={selected}
          hidden={hiddenTicked}
          actions={bulk}
          onRun={runBulkAction}
          onClear={() => setPicked(new Set())}
          busy={bulkBusy}
          sections={rail.sections}
        />
      )}
      {bulkOutcome && (
        <p className="wd-bulk-outcome" role="status">
          {bulkOutcome}{' '}
          <button type="button" className="wd-link-button" onClick={() => setBulkOutcome(null)}>
            OK
          </button>
        </p>
      )}
      {filtered.length === 0 ? (
        <div className="wd-tab-empty">
          {sessions.length === 0
            ? 'No worktrees yet. Run `work tree <target> <branch>` in any terminal, or click "New worktree" above.'
            : 'No sessions match the current filter.'}
        </div>
      ) : railGroups ? (
        <div className="wd-session-groups">
          {railGroups.map((g) => (
            <section key={g.key} className="wd-session-group">
              <h2 className="wd-session-group-header">
                <span className="wd-session-group-name">{g.title ?? 'Not in a section'}</span>
                <span className="wd-tab-header-muted">({g.sessions.length})</span>
              </h2>
              {renderTable(g.sessions)}
            </section>
          ))}
        </div>
      ) : ages ? (
        <div className="wd-session-groups">
          {ages.map((g, _i, all) => {
            // A search shows its matches, the older ones too.
            const folded = (x: { key: AgeBucket }) => x.key === 'older' && !showOlder && query.trim() === '';
            if (folded(g)) {
              return (
                <button key={g.key} type="button" className="wd-link-button wd-session-older" onClick={() => setShowOlder(true)}>
                  Show {g.sessions.length} older
                </button>
              );
            }
            return (
              <section key={g.key} className={`wd-session-group wd-session-age wd-session-age-${g.key}`}>
                {/* A heading only to tell two shown tables apart. */}
                {all.filter((x) => !folded(x)).length > 1 && (
                  <h2 className="wd-session-group-header">
                    <span className="wd-session-group-name">{AGE_LABEL[g.key]}</span>
                    <span className="wd-tab-header-muted">({g.sessions.length})</span>
                    {g.key === 'older' && query.trim() === '' && (
                      <button type="button" className="wd-link-button wd-session-age-toggle" onClick={() => setShowOlder(false)}>
                        Hide
                      </button>
                    )}
                  </h2>
                )}
                {renderTable(g.sessions)}
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
                  <span className="wd-session-group-kind" title="Multi-repo group">
                    group
                  </span>
                )}
                {g.repos.length > 0 && (
                  <ul className="wd-session-group-repos" aria-label="Repos in this group">
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
      {rowMenu && <RowMenu x={rowMenu.x} y={rowMenu.y} items={menuItems(rowMenu.s)} onClose={() => setRowMenu(null)} />}
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
      void searchConversations(q).then(
        (h) => live && setHits(h),
        () => live && setHits([]),
      );
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
                <span className="wd-tab-header-muted">{sn.role === 'you' ? 'You' : sn.role === 'summary' ? 'Summary' : 'Claude'}:</span>{' '}
                {sn.text}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "View ▾": how the table is cut — status filter, rail filter, grouping,
 * sort, archived, and selecting several for the bulk bar — in one place
 * instead of a row of controls.
 */
function ViewMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  return (
    <div className="wd-view-menu" ref={ref}>
      <button type="button" className="wd-btn-secondary" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        View ▾
      </button>
      {open && (
        <div className="wd-view-menu-panel" role="group" aria-label="View">
          {children}
        </div>
      )}
    </div>
  );
}

/** "84% full": the conversation is past the warning line (70%); nothing below it. */
export function contextFullText(s: SessionSummary): string | null {
  const c = s.context;
  if (!c || c.window <= 0) return null;
  const ratio = Math.min(1, c.used / c.window);
  return ratio >= CONTEXT_WARN ? `${Math.round(ratio * 100)}% full` : null;
}

interface RowProps {
  /** 📌, or its rail section's name. */
  railTag?: string | null;
  session: SessionSummary;
  onOpen: () => void;
  /** Its ⋯ menu, at (x, y). */
  onMenu: (x: number, y: number) => void;
  selecting: boolean;
  picked: boolean;
  onPick: (on: boolean) => void;
}

/** One session: status, name, summary, changes, when. Click opens it; ⋯ (or right-click) for the rest. */
function SessionRow({ session: s, onOpen, onMenu, selecting, picked, onPick, railTag }: RowProps) {
  const kind = displayStatus(s);
  const archived = isArchived(s);
  const repos = groupRepoNames(s);
  const archiving = useArchivePending(s.id); // also one started elsewhere (the session header)
  const full = contextFullText(s);
  const named = s.titleIsYours && !!s.title;

  return (
    <tr
      className={
        'wd-session-row' +
        (archived ? ' wd-session-row-archived' : '') +
        (kind === 'needs_input' || kind === 'done' ? ' wd-session-row-unseen' : '')
      }
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
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
      {selecting && (
        <td className="wd-st-col-pick" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={picked}
            onChange={(e) => onPick(e.target.checked)}
            aria-label={`Select ${s.target} ${s.branch}`}
          />
        </td>
      )}
      <td className="wd-st-col-status">
        <span className="wd-st-status" title={statusHint(kind)}>
          <StatusIcon kind={kind} muted={!!s.snoozed} />
          <span className="wd-st-label">{DISPLAY_LABEL[kind]}</span>
        </span>
      </td>
      <td className="wd-st-session">
        <span className="wd-st-branch" title={named ? `${s.title} (${s.branch})` : s.branch}>
          {named ? s.title : s.branch || '(base)'}
        </span>{' '}
        <span className="wd-st-target">{s.target}</span>
        {s.isGroup && (
          <span
            className="wd-session-group-kind wd-session-group-kind-hint"
            title={repos.length ? `Multi-repo group: ${repos.join(', ')}` : 'Multi-repo group'}
          >
            group
          </span>
        )}
        {railTag && (
          <span
            className={'wd-st-rail' + (railTag === '📌' ? ' wd-st-rail-pin' : '')}
            title={railTag === '📌' ? 'Pinned in the rail' : `In the rail's “${railTag}” section`}
          >
            {railTag}
          </span>
        )}
        {full && (
          <span
            className="wd-st-full"
            title={`The conversation is ${full}: start fresh for the next task (work tree … --fresh, or /clear)`}
          >
            {full}
          </span>
        )}
        {archived && (
          <span
            className="wd-archived-pill"
            title={
              s.archive
                ? s.archive.worktreeRemoved
                  ? `Worktree removed; its branch and the conversation are kept${s.archive.savedUncommitted ? `, and ${s.archive.savedUncommitted} uncommitted file${s.archive.savedUncommitted === 1 ? '' : 's'}` : ''}. Restore recreates it${s.archive.savedUncommitted ? ' and puts them back' : ''}.${s.archive.kept ? ` Also kept: ${s.archive.kept}.` : ''}`
                  : `Worktree kept: ${s.archive.keptBecause ?? 'it has work in it'}${s.archive.kept ? `. Also kept: ${s.archive.kept}.` : ''}`
                : 'Archived'
            }
          >
            {s.archive?.worktreeRemoved
              ? `archived · folder removed${s.archive.savedUncommitted ? ` · ${s.archive.savedUncommitted} changes saved` : ''}`
              : 'archived'}
          </span>
        )}
      </td>
      <td className="wd-st-col-summary">
        {(() => {
          // An archived session: what it was about (its archive's summary / first prompt).
          const text =
            s.attention?.summary ?? (archived ? (s.archive?.written ?? s.archive?.lastSummary ?? s.archive?.prompts[0]) : undefined) ?? '';
          return (
            <span className="wd-st-summary" title={text}>
              {text}
            </span>
          );
        })()}
      </td>
      <td className="wd-st-col-changes">
        <DiffStatChip session={s} />
        {s.overlaps?.length ? (
          <span className="wd-st-overlap" title={overlapTitle(s)} aria-label="Changes the same files as another session">
            ⚠
          </span>
        ) : null}
      </td>
      <td className="wd-st-col-when">
        {archiving !== undefined ? (archiving ? 'archiving…' : 'restoring…') : relativeTime(lastActiveAt(s))}
      </td>
      <td className="wd-st-col-more" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="wd-st-more"
          aria-label={`Actions for ${s.target} ${s.branch}`}
          title="Archive, snooze, open in a terminal, delete…"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.left, r.bottom + 4);
          }}
        >
          ⋯
        </button>
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
