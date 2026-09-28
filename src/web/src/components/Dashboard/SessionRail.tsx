import { useMemo } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { PrChips } from './SessionBits.js';
import {
  DISPLAY_LABEL,
  displayStatus,
  formatDiffStat,
  isArchived,
  stableSessionOrder,
  type DisplayKind,
  type PrLookup,
} from '../../state/session-display.js';
import { relativeTime } from '../../utils/time.js';

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
  /** Optional cap on rail rows before a "+N more" expander appears.
   *  Defaults to a sensible value if omitted. */
  maxVisible?: number;
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
  return { text: relativeTime(s.attention?.updatedAt ?? s.lastAccessedAt), cls: '' };
}

/**
 * Left navigation rail — every non-archived session as a compact two-line
 * row (Emdash-style): branch + status slot, then `target · summary` with the
 * diff size and PR badge. Always visible across dashboard tabs so the user
 * can context-switch in one click without losing the lens they're on.
 *
 * Order is STABLE (project, then most recently entered) — see
 * stableSessionOrder; urgency ordering lives in the Inbox and on `n`.
 */
export function SessionRail({
  sessions,
  activeSessionId,
  onSelect,
  onNewWorktree,
  prsFor,
  maxVisible = 40,
}: Props) {
  const sorted = useMemo(
    () => stableSessionOrder(sessions.filter((s) => !isArchived(s))),
    [sessions],
  );

  const visible = sorted.slice(0, maxVisible);
  const overflow = sorted.length - visible.length;

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
      {sorted.length === 0 ? (
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
              <li key={s.id}>
                <button
                  type="button"
                  className={
                    'wd-dash-rail-item' +
                    (isActive ? ' wd-dash-rail-item-active' : '') +
                    (kind === 'needs_input' || kind === 'done' ? ' wd-dash-rail-item-unseen' : '')
                  }
                  onClick={() => onSelect(s.id)}
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
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="wd-dash-rail-overflow">
              +{overflow} more
            </li>
          )}
        </ul>
      )}
    </aside>
  );
}
