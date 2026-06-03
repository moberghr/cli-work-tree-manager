import { useMemo } from 'react';
import type { SessionSummary } from '../../api/client.js';

interface Props {
  sessions: SessionSummary[];
  /** Currently-drilled-into session, if any. Highlights the matching
   *  rail item. */
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewWorktree: () => void;
  /** Optional cap on rail rows before a "+N more" expander appears.
   *  Defaults to a sensible value if omitted. */
  maxVisible?: number;
}

/** Map activity to a CSS modifier — the dot color comes from CSS. */
function dotClass(s: SessionSummary): string {
  switch (s.activityState) {
    case 'active':
      return 'wd-rail-dot wd-rail-dot-active';
    case 'open':
      return 'wd-rail-dot wd-rail-dot-open';
    default:
      return 'wd-rail-dot wd-rail-dot-stale';
  }
}

/**
 * Left navigation rail — a 160px column listing every worktree session
 * with its activity dot, name, and (subtly) target. Always visible across
 * dashboard tabs so the user can context-switch to any worktree in one
 * click without losing the lens they're on.
 *
 * Clicking a row drills into the session detail view; a small `+` at the
 * bottom opens the new-worktree modal.
 */
export function SessionRail({
  sessions,
  activeSessionId,
  onSelect,
  onNewWorktree,
  maxVisible = 30,
}: Props) {
  // Most-recently-active first. Stable order so the rail doesn't shuffle
  // on every SSE tick — sorted by lastAccessedAt + activity state.
  const sorted = useMemo(() => {
    const score = (s: SessionSummary): number => {
      // Active = highest, open = medium, stale = lowest. Within each
      // band, lastAccessedAt (later = higher).
      const band =
        s.activityState === 'active'
          ? 2_000_000_000_000
          : s.activityState === 'open'
            ? 1_000_000_000_000
            : 0;
      const last = Date.parse(s.lastAccessedAt) || 0;
      return band + last;
    };
    return [...sessions].sort((a, b) => score(b) - score(a));
  }, [sessions]);

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
      {sessions.length === 0 ? (
        <p className="wd-dash-rail-empty">
          No worktrees yet. Click + to create one.
        </p>
      ) : (
        <ul className="wd-dash-rail-list">
          {visible.map((s) => {
            const isActive = s.id === activeSessionId;
            const label = s.branch || s.target;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={
                    'wd-dash-rail-item' +
                    (isActive ? ' wd-dash-rail-item-active' : '')
                  }
                  onClick={() => onSelect(s.id)}
                  title={`${s.target} · ${s.branch}`}
                >
                  <span className={dotClass(s)} aria-hidden />
                  <span className="wd-dash-rail-name">{label}</span>
                  {!!s.pendingForClaudeCount && s.pendingForClaudeCount > 0 && (
                    <span
                      className="wd-dash-rail-pending"
                      title={`${s.pendingForClaudeCount} pending for Claude`}
                    >
                      →{s.pendingForClaudeCount}
                    </span>
                  )}
                  {!!s.draftCount && s.draftCount > 0 && (
                    <span
                      className="wd-dash-rail-drafts"
                      title={`${s.draftCount} draft comment${s.draftCount === 1 ? '' : 's'}`}
                    >
                      {s.draftCount}
                    </span>
                  )}
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
