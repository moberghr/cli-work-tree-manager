import { useMemo, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { ClaudesChip, PrChips } from './SessionBits.js';
import {
  DISPLAY_LABEL,
  displayStatus,
  formatDiffStat,
  railSessions,
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
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  // Every current session, plus older ones only on request — and the
  // selected one always stays visible. (A length cap here used to cut the
  // pinned selection off once there were 40+ current sessions, and took it
  // out of the "+N older" count too, so it vanished.)
  const pinned = !showOlder && activeSessionId ? older.filter((s) => s.id === activeSessionId) : [];
  const visible = showOlder ? [...current, ...older] : [...current, ...pinned];
  const overflow = showOlder ? 0 : older.length - pinned.length;

  const shownIds = visible.map((s) => s.id);
  const move = (id: string, beforeId: string | null) => onReorder?.(moveSession(shownIds, id, beforeId, order ?? []));
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
      {current.length + older.length === 0 ? (
        <p className="wd-dash-rail-empty">
          No worktrees yet. Click + to create one.
        </p>
      ) : (
        <ul className="wd-dash-rail-list">
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
                draggable={!!onReorder}
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
                    if (!onReorder || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                    e.preventDefault();
                    const i = shownIds.indexOf(s.id);
                    if (e.key === 'ArrowUp' && i > 0) move(s.id, shownIds[i - 1]);
                    if (e.key === 'ArrowDown' && i < shownIds.length - 1) move(s.id, shownIds[i + 2] ?? null);
                  }}
                  title={
                    `${s.target} · ${s.branch}\n${DISPLAY_LABEL[kind]}` +
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
                        {summary ? ` · ${summary}` : ''}
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
