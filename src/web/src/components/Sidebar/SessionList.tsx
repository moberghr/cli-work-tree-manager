import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { relativeTime } from '../../utils/time.js';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface Group {
  /** Synthetic stable key used for open-state tracking and React keys. */
  key: string;
  /** Display label rendered in the group header. */
  label: string;
  kind: 'recent' | 'target';
  isGroup: boolean;
  sessions: SessionSummary[];
  /** Most recent lastAccessedAt across all sessions in this group; drives group sort. */
  lastTouched: string;
}

const RECENT_LIMIT = 10;
const RECENT_KEY = '__recent__';

function buildGroups(sessions: SessionSummary[]): Group[] {
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

  // Only worth adding a Recent shortcut when the list is long enough that
  // the by-target view alone is unwieldy. Otherwise it's just duplication.
  if (sessions.length <= RECENT_LIMIT) return targetGroups;

  const recentSessions = [...sessions]
    .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))
    .slice(0, RECENT_LIMIT);
  const recentGroup: Group = {
    key: RECENT_KEY,
    label: `Recent (${recentSessions.length})`,
    kind: 'recent',
    isGroup: false,
    sessions: recentSessions,
    lastTouched: recentSessions[0]?.lastAccessedAt ?? '',
  };
  return [recentGroup, ...targetGroups];
}

function matchesQuery(s: SessionSummary, q: string): boolean {
  if (!q) return true;
  const haystack = (s.target + ' ' + s.branch).toLowerCase();
  return haystack.includes(q);
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => buildGroups(sessions), [sessions]);

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
          /* When the user is filtering, force every matching group open so
             results are visible. Otherwise honour the user-controlled state. */
          isOpen={q ? true : openKeys.has(group.key)}
          onToggle={(open) => {
            // Ignore toggles while filtering — they'd just snap back open.
            if (q) return;
            setGroupOpen(group.key, open);
          }}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface GroupProps {
  group: Group;
  selectedId: string | null;
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  onSelect: (id: string) => void;
}

function SessionGroup({
  group,
  selectedId,
  isOpen,
  onToggle,
  onSelect,
}: GroupProps) {
  const className =
    'wd-web-group' +
    (group.kind === 'recent' ? ' wd-web-group-recent' : '');
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
        {group.sessions.map((s) => (
          <li
            key={s.id}
            className={
              'wd-web-session-row' +
              (s.id === selectedId ? ' wd-web-session-active' : '')
            }
            onClick={() => onSelect(s.id)}
            title={s.paths.join('\n')}
          >
            {group.kind === 'recent' && (
              <div className="wd-web-session-target-line">{s.target}</div>
            )}
            <div className="wd-web-session-row-main">
              <span className="wd-web-session-branch">{s.branch}</span>
              <span
                className="wd-web-session-age"
                title={new Date(s.lastAccessedAt).toLocaleString()}
              >
                {relativeTime(s.lastAccessedAt)}
              </span>
            </div>
            {s.baseBranch && (
              <div className="wd-web-session-base">vs {s.baseBranch}</div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
