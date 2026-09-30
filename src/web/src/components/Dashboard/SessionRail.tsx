import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { ClaudesChip, PrChips } from './SessionBits.js';
import {
  DISPLAY_LABEL,
  displayStatus,
  formatDiffStat,
  railSessions,
  sessionMatches,
  type DisplayKind,
  type PrLookup,
} from '../../state/session-display.js';
import { relativeTime } from '../../utils/time.js';
import { moveSession } from '../../../../core/session-order.js';
import { lastActiveAt } from '../../state/session-display.js';

interface Props {
  sessions: SessionSummary[];
  /** Currently-drilled-into session, if any. Highlights the matching
   *  rail item. */
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewWorktree: () => void;
  /** Open PRs for a session (from the PRs pane data); optional — rows just
   *  skip the badge without it. */
  prsFor?: PrLookup;
  /** Your drag order (session ids, top first). */
  order?: string[];
  /** Set when rows can be dragged (or moved with Alt+↑/↓) into a new order. */
  onReorder?: (order: string[]) => void;
}

/** Status → CSS modifier; the colors live in CSS. */
export function dotClass(kind: DisplayKind): string {
  return `wd-rail-dot wd-rail-dot-${kind}`;
}

/** Right-hand status slot: the one thing worth saying about this row. */
function statusSlot(s: SessionSummary, kind: DisplayKind): { text: string; cls: string } {
  const since = s.attention?.since ?? s.lastAccessedAt;
  if (kind === 'needs_input') return { text: `◆ ${relativeTime(since)}`, cls: 'wd-rail-slot-needs' };
  if (kind === 'done') return { text: `● ${relativeTime(since)}`, cls: 'wd-rail-slot-done' };
  if (kind === 'working') return { text: relativeTime(since), cls: 'wd-rail-slot-working' };
  if (kind === 'review') return { text: `💬 ${s.openReviewThreads}`, cls: 'wd-rail-slot-review' };
  return { text: relativeTime(lastActiveAt(s)), cls: '' };
}

/**
 * Left navigation rail — every non-archived session as a compact two-line
 * row (Emdash-style): branch + status slot, then `target · summary` with the
 * diff size and PR badge. Always visible across dashboard tabs so the user
 * can context-switch in one click without losing the lens they're on.
 *
 * Order is yours: drag a row (or Alt+↑/↓ on it) and it stays there, in
 * every window (state.db). Rows you never placed come first, in the stable
 * order (project, then most recently entered — stableSessionOrder). Urgency
 * ordering lives in the Inbox and on `n`.
 */
export function SessionRail({
  sessions,
  activeSessionId,
  onSelect,
  onNewWorktree,
  prsFor,
  order,
  onReorder,
}: Props) {
  const [showOlder, setShowOlder] = useState(false);
  const { current, older } = useMemo(() => railSessions(sessions, Date.now(), order ?? []), [sessions, order]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  // Every current session, plus older ones only on request — and the
  // selected one always stays visible. (A length cap here used to cut the
  // pinned selection off once there were 40+ current sessions, and took it
  // out of the "+N older" count too, so it vanished.)
  const pinned = !showOlder && activeSessionId ? older.filter((s) => s.id === activeSessionId) : [];
  const searching = query.trim() !== '';
  // A search looks through the older sessions too.
  const visible = searching
    ? [...current, ...older].filter((s) => sessionMatches(s, query))
    : showOlder
      ? [...current, ...older]
      : [...current, ...pinned];
  const overflow = searching || showOlder ? 0 : older.length - pinned.length;
  // Moving a row among search results would scramble the full order.
  const canReorder = !!onReorder && !searching;

  // `/` jumps to the search box — not while typing somewhere (a terminal's
  // input included, so `/` in Claude still reaches Claude).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shownIds = visible.map((s) => s.id);
  const move = (id: string, beforeId: string | null) => {
    if (canReorder) onReorder?.(moveSession(shownIds, id, beforeId, order ?? []));
  };
  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  return (
    <aside
      className="wd-dash-rail"
      role="navigation"
      aria-label="Sessions"
    >
      <header className="wd-dash-rail-header">
        <h2>Sessions</h2>
        <button
          type="button"
          className="wd-dash-rail-new"
          onClick={onNewWorktree}
          title="New worktree"
          aria-label="New worktree"
        >
          +
        </button>
      </header>
      {current.length + older.length > 0 && (
        <input
          ref={searchRef}
          className="wd-dash-rail-search"
          type="search"
          placeholder="Search sessions   /"
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              e.currentTarget.blur();
            } else if (e.key === 'Enter' && visible[0]) {
              onSelect(visible[0].id);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              listRef.current?.querySelector<HTMLButtonElement>('.wd-dash-rail-item')?.focus();
            }
          }}
        />
      )}
      {searching && visible.length === 0 && <p className="wd-dash-rail-empty">No session matches “{query.trim()}”.</p>}
      {current.length + older.length === 0 ? (
        <p className="wd-dash-rail-empty">
          No worktrees yet. Click + to create one.
        </p>
      ) : (
        <ul className="wd-dash-rail-list" ref={listRef}>
          {visible.map((s) => {
            const kind = displayStatus(s);
            const isActive = s.id === activeSessionId;
            const label = s.branch || s.target;
            const slot = statusSlot(s, kind);
            const stat = formatDiffStat(s);
            const prs = prsFor?.(s) ?? [];
            const summary = s.attention?.summary;
            return (
              <li
                key={s.id}
                draggable={canReorder}
                className={
                  (dragId === s.id ? 'wd-dash-rail-dragging' : '') +
                  (drop?.id === s.id && dragId !== s.id ? (drop.before ? ' wd-dash-rail-drop-before' : ' wd-dash-rail-drop-after') : '')
                }
                onDragStart={(e) => {
                  setDragId(s.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', s.id);
                }}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const before = e.clientY < r.top + r.height / 2;
                  if (drop?.id !== s.id || drop.before !== before) setDrop({ id: s.id, before });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId && drop) {
                    const i = shownIds.indexOf(drop.id);
                    move(dragId, drop.before ? drop.id : shownIds[i + 1] ?? null);
                  }
                  endDrag();
                }}
                onDragEnd={endDrag}
              >
                <button
                  type="button"
                  className={
                    'wd-dash-rail-item' +
                    (isActive ? ' wd-dash-rail-item-active' : '') +
                    (kind === 'needs_input' || kind === 'done' ? ' wd-dash-rail-item-unseen' : '')
                  }
                  onClick={() => onSelect(s.id)}
                  onKeyDown={(e) => {
                    if (!canReorder || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                    e.preventDefault();
                    const i = shownIds.indexOf(s.id);
                    if (e.key === 'ArrowUp' && i > 0) move(s.id, shownIds[i - 1]);
                    if (e.key === 'ArrowDown' && i < shownIds.length - 1) move(s.id, shownIds[i + 2] ?? null);
                  }}
                  title={
                    `${s.target} · ${s.branch}${s.title ? `\n${s.title}` : ''}\n${DISPLAY_LABEL[kind]}` +
                    (summary ? ` — ${summary}` : '')
                  }
                >
                  <span className={dotClass(kind)} aria-label={DISPLAY_LABEL[kind]} role="img" />
                  <span className="wd-dash-rail-lines">
                    <span className="wd-dash-rail-line">
                      <span className="wd-dash-rail-name">{label}</span>
                      <span className={'wd-dash-rail-slot ' + slot.cls}>{slot.text}</span>
                    </span>
                    <span className="wd-dash-rail-line wd-dash-rail-sub">
                      <span className="wd-dash-rail-summary">
                        {s.target}
                        {summary ? ` · ${summary}` : s.title ? ` · ${s.title}` : ''}
                      </span>
                      {!!s.pendingForClaudeCount && s.pendingForClaudeCount > 0 && (
                        <span
                          className="wd-dash-rail-pending"
                          title={`${s.pendingForClaudeCount} pending for Claude`}
                        >
                          →{s.pendingForClaudeCount}
                        </span>
                      )}
                      {stat && (
                        <span className="wd-dash-rail-stat" title={`${s.diffStat!.files} file(s) changed`}>
                          {stat}
                        </span>
                      )}
                      <PrChips prs={prs} />
                      <ClaudesChip session={s} compact />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="wd-dash-rail-overflow">
              <button
                type="button"
                className="wd-dash-rail-older"
                onClick={() => setShowOlder(true)}
                title="Sessions not entered in the last 14 days and not running"
              >
                +{overflow} older
              </button>
            </li>
          )}
          {showOlder && older.length > 0 && (
            <li className="wd-dash-rail-overflow">
              <button type="button" className="wd-dash-rail-older" onClick={() => setShowOlder(false)}>
                Hide older
              </button>
            </li>
          )}
        </ul>
      )}
    </aside>
  );
}
