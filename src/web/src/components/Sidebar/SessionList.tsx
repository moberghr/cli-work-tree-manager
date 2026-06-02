import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { relativeTime } from '../../utils/time.js';
import { SessionActionsMenu } from './SessionActionsMenu.js';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  /** Per-session viewed-count baseline (from localStorage). Used to compute
   *  the unread badge: `claudeCount - viewed[id]`. */
  viewed?: Record<string, number>;
  /** Session IDs currently held in the dashboard's "open window", in
   *  most-recently-opened-first order. Rendered as a pinned "Active"
   *  group at the very top so the user's working set is one click away. */
  activeIds?: string[];
  onSelect: (id: string) => void;
  /** Called when the user clicks the × on an Active row. Removes the
   *  session from the Active set (the row still exists in its target
   *  group below). No-op for rows outside Active. */
  onCloseActive?: (id: string) => void;
}

interface Group {
  /** Synthetic stable key used for open-state tracking and React keys. */
  key: string;
  /** Display label rendered in the group header. */
  label: string;
  kind: 'active' | 'recent' | 'target';
  isGroup: boolean;
  sessions: SessionSummary[];
  /** Most recent lastAccessedAt across all sessions in this group; drives group sort. */
  lastTouched: string;
}

const RECENT_LIMIT = 10;
const RECENT_KEY = '__recent__';
const ACTIVE_KEY = '__active__';

function buildGroups(
  sessions: SessionSummary[],
  activeIds: string[],
): Group[] {
  const byTarget = new Map<string, Group>();
  for (const s of sessions) {
    const existing = byTarget.get(s.target);
    if (existing) {
      existing.sessions.push(s);
      if (s.lastAccessedAt > existing.lastTouched) {
        existing.lastTouched = s.lastAccessedAt;
      }
    } else {
      byTarget.set(s.target, {
        key: 'target:' + s.target,
        label: s.target,
        kind: 'target',
        isGroup: s.isGroup,
        sessions: [s],
        lastTouched: s.lastAccessedAt,
      });
    }
  }
  for (const g of byTarget.values()) {
    g.sessions.sort((a, b) =>
      b.lastAccessedAt.localeCompare(a.lastAccessedAt),
    );
  }
  const targetGroups = Array.from(byTarget.values()).sort((a, b) =>
    b.lastTouched.localeCompare(a.lastTouched),
  );

  // "Active" group — sessions currently open in the dashboard's view
  // window, ordered most-recently-opened first. Pinned to the very top
  // so the user's working set is one click away. The order is driven by
  // the caller (DashboardApp's MRU list), NOT by lastAccessedAt — the
  // user's recent attention is the more useful signal here.
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const activeSessions = activeIds
    .map((id) => byId.get(id))
    .filter((s): s is SessionSummary => !!s);
  const activeGroup: Group | null =
    activeSessions.length > 0
      ? {
          key: ACTIVE_KEY,
          label: `Active (${activeSessions.length})`,
          kind: 'active',
          isGroup: false,
          sessions: activeSessions,
          lastTouched: activeSessions[0]?.lastAccessedAt ?? '',
        }
      : null;

  // The Recent shortcut only earns its slot once the by-target view is
  // long enough that scanning it gets annoying. Otherwise it'd just
  // duplicate what target groups already show.
  let recentGroup: Group | null = null;
  if (sessions.length > RECENT_LIMIT) {
    const recentSessions = [...sessions]
      .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))
      .slice(0, RECENT_LIMIT);
    recentGroup = {
      key: RECENT_KEY,
      label: `Recent (${recentSessions.length})`,
      kind: 'recent',
      isGroup: false,
      sessions: recentSessions,
      lastTouched: recentSessions[0]?.lastAccessedAt ?? '',
    };
  }

  return [
    ...(activeGroup ? [activeGroup] : []),
    ...(recentGroup ? [recentGroup] : []),
    ...targetGroups,
  ];
}

function matchesQuery(s: SessionSummary, q: string): boolean {
  if (!q) return true;
  const haystack = (s.target + ' ' + s.branch).toLowerCase();
  return haystack.includes(q);
}

export function SessionList({
  sessions,
  selectedId,
  viewed,
  activeIds,
  onSelect,
  onCloseActive,
}: Props) {
  const [query, setQuery] = useState('');

  const groups = useMemo(
    () => buildGroups(sessions, activeIds ?? []),
    [sessions, activeIds],
  );

  // Apply filter: each group keeps only matching sessions; empty groups drop.
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, sessions: g.sessions.filter((s) => matchesQuery(s, q)) }))
      .filter((g) => g.sessions.length > 0);
  }, [groups, q]);

  const selectedTargetKey = (() => {
    const t = sessions.find((s) => s.id === selectedId)?.target;
    return t ? 'target:' + t : null;
  })();

  // Track which groups the user has explicitly opened, keyed by Group.key.
  // Selecting a session ADDS its target group to the set but never removes —
  // the only way a group collapses is by clicking its chevron.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (sessions.length === 0) return initial;
    // Active always starts open — it's the user's current working set,
    // showing one click away is the whole point of pinning it to the top.
    initial.add(ACTIVE_KEY);
    // Recent (when present) starts open since it's the most useful shortcut.
    if (sessions.length > RECENT_LIMIT) initial.add(RECENT_KEY);
    const targets = Array.from(new Set(sessions.map((s) => s.target)));
    if (targets.length <= 3) {
      targets.forEach((t) => initial.add('target:' + t));
    } else if (selectedId) {
      const t = sessions.find((s) => s.id === selectedId)?.target;
      if (t) initial.add('target:' + t);
    }
    return initial;
  });

  useEffect(() => {
    if (!selectedTargetKey) return;
    setOpenKeys((prev) => {
      if (prev.has(selectedTargetKey)) return prev;
      const next = new Set(prev);
      next.add(selectedTargetKey);
      return next;
    });
  }, [selectedTargetKey]);

  function setGroupOpen(key: string, open: boolean) {
    setOpenKeys((prev) => {
      const has = prev.has(key);
      if (open === has) return prev;
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  if (sessions.length === 0) {
    return <p className="wd-web-empty-list">No sessions yet.</p>;
  }

  return (
    <div className="wd-web-sidebar-body">
      <input
        className="wd-web-filter"
        type="search"
        placeholder="Filter by target or branch…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {filtered.length === 0 && (
        <p className="wd-web-empty-list">No sessions match.</p>
      )}
      {filtered.map((group) => (
        <SessionGroup
          key={group.key}
          group={group}
          selectedId={selectedId}
          viewed={viewed}
          /* When the user is filtering, force every matching group open so
             results are visible. Otherwise honour the user-controlled state. */
          isOpen={q ? true : openKeys.has(group.key)}
          onToggle={(open) => {
            // Ignore toggles while filtering — they'd just snap back open.
            if (q) return;
            setGroupOpen(group.key, open);
          }}
          onSelect={onSelect}
          onCloseActive={
            group.kind === 'active' ? onCloseActive : undefined
          }
        />
      ))}
    </div>
  );
}

interface GroupProps {
  group: Group;
  selectedId: string | null;
  viewed?: Record<string, number>;
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  onSelect: (id: string) => void;
  /** Set only for the Active group — renders an × on each row. */
  onCloseActive?: (id: string) => void;
}

function SessionGroup({
  group,
  selectedId,
  viewed,
  isOpen,
  onToggle,
  onSelect,
  onCloseActive,
}: GroupProps) {
  const className =
    'wd-web-group' +
    (group.kind === 'recent' ? ' wd-web-group-recent' : '') +
    (group.kind === 'active' ? ' wd-web-group-active' : '');
  return (
    <details
      className={className}
      open={isOpen}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="wd-web-group-summary">
        <span className="wd-web-group-target">
          {group.label}
          {group.kind === 'target' && group.isGroup ? (
            <span className="wd-web-group-tag">group</span>
          ) : null}
        </span>
        <span className="wd-web-group-count">{group.sessions.length}</span>
      </summary>
      <ul className="wd-web-session-list">
        {group.sessions.map((s) => {
          const seen = viewed?.[s.id] ?? 0;
          const unread = Math.max(0, (s.claudeCount ?? 0) - seen);
          const drafts = s.draftCount ?? 0;
          // Activity dot reflects Claude's transcript mtime (catches any
          // terminal, not just ours). PTY status from our own pool wins
          // when present — it's the most authoritative signal we have.
          const activity = s.ptyStatus === 'running' ? 'active' : s.activityState;
          const activityLabel =
            activity === 'active'
              ? 'Claude is active'
              : activity === 'open'
                ? `Terminal open${s.lastActivity ? ' · last activity ' + relativeTime(new Date(s.lastActivity).toISOString()) : ''}`
                : 'No active terminal';
          return (
            <li
              key={s.id}
              className={
                'wd-web-session-row' +
                (s.id === selectedId ? ' wd-web-session-active' : '')
              }
              onClick={() => onSelect(s.id)}
              title={s.paths.join('\n')}
            >
              {(group.kind === 'recent' || group.kind === 'active') && (
                <div className="wd-web-session-target-line">{s.target}</div>
              )}
              <div className="wd-web-session-row-main">
                {/* Activity dot sits inline before the branch so it reads
                    as a status indicator on the row itself — like the
                    green dot next to a name in GitHub/Slack — rather
                    than as a separate badge on a line below. */}
                {activity && activity !== 'stale' ? (
                  <span
                    className={`wd-web-activity wd-web-activity-${activity}`}
                    title={activityLabel}
                    aria-label={activityLabel}
                  />
                ) : (
                  <span
                    className="wd-web-activity wd-web-activity-placeholder"
                    aria-hidden="true"
                  />
                )}
                <span className="wd-web-session-branch">{s.branch}</span>
                <span
                  className="wd-web-session-age"
                  title={new Date(s.lastAccessedAt).toLocaleString()}
                >
                  {relativeTime(s.lastAccessedAt)}
                </span>
                <SessionActionsMenu
                  sessionId={s.id}
                  label={`${s.target} · ${s.branch}`}
                  onRemoved={() => onCloseActive?.(s.id)}
                />
                {onCloseActive && (
                  <button
                    type="button"
                    className="wd-web-session-close"
                    title="Remove from Active"
                    aria-label="Remove from Active"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseActive(s.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="wd-web-session-badges">
                {unread > 0 && (
                  <span
                    className="wd-web-badge wd-web-badge-unread"
                    title={`${unread} new Claude comment${unread === 1 ? '' : 's'}`}
                  >
                    {unread}
                  </span>
                )}
                {drafts > 0 && (
                  <span
                    className="wd-web-badge wd-web-badge-draft"
                    title={`${drafts} draft${drafts === 1 ? '' : 's'}`}
                  >
                    {drafts}d
                  </span>
                )}
                {(s.pendingForClaudeCount ?? 0) > 0 && (
                  <span
                    className="wd-web-badge wd-web-badge-pending"
                    title={`${s.pendingForClaudeCount} comment(s) waiting for Claude's next turn`}
                  >
                    →{s.pendingForClaudeCount}
                  </span>
                )}
                {s.baseBranch && (
                  <span className="wd-web-session-base">vs {s.baseBranch}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
