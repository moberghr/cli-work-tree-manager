import type { SessionSummary } from '../api/client.js';
import type { PrInfo } from '../api/panes.js';
import type { SessionSubTab } from './dashboard-route.js';

/**
 * ONE status vocabulary for every view (rail, Sessions table, inbox, header
 * strip). Hook-driven attention wins when a session has it; otherwise we fall
 * back to the older transcript-activity signal, so a session never shows two
 * contradicting states in two places.
 *
 *   needs_input — blocked on you (permission / question)
 *   done        — finished a turn you haven't looked at
 *   working     — mid-turn
 *   quiet       — finished, and you've seen it
 *   active/open/stale — no hook status yet; transcript activity only
 */
export type DisplayKind =
  | 'needs_input'
  | 'done'
  | 'working'
  | 'quiet'
  | 'active'
  | 'open'
  | 'stale';

export function displayStatus(s: SessionSummary): DisplayKind {
  const a = s.attention;
  if (a) {
    if (a.state === 'needs_input') return 'needs_input';
    if (a.state === 'working') return 'working';
    return a.seen ? 'quiet' : 'done';
  }
  if (s.activityState === 'active') return 'active';
  if (s.activityState === 'open') return 'open';
  return 'stale';
}

export const DISPLAY_LABEL: Record<DisplayKind, string> = {
  needs_input: 'Needs your input',
  done: 'Done',
  working: 'Working',
  quiet: 'Idle',
  active: 'Active',
  open: 'Open',
  stale: 'Stale',
};

/** Coarse buckets the Sessions header counts and filters by. */
export type StatusBucket = 'needs' | 'working' | 'idle' | 'stale';

export function statusBucket(kind: DisplayKind): StatusBucket {
  switch (kind) {
    case 'needs_input':
    case 'done':
      return 'needs';
    case 'working':
    case 'active':
      return 'working';
    case 'quiet':
    case 'open':
      return 'idle';
    default:
      return 'stale';
  }
}

/** Where opening a session should land: the terminal to answer a question
 *  (or watch it work), the diff to review finished work. */
export function defaultSubTab(s: SessionSummary): SessionSubTab {
  const k = displayStatus(s);
  return k === 'needs_input' || k === 'working' ? 'term' : 'diff';
}

export function isArchived(s: SessionSummary): boolean {
  return !!s.archivedAt;
}

/**
 * The rail's order: STABLE — by project, then most recently entered. It
 * deliberately ignores status: a list that reshuffles while you look at it
 * is a top complaint about these tools; urgency ordering is the Inbox's
 * and `n`'s job.
 */
export function stableSessionOrder(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort(
    (a, b) =>
      a.target.toLowerCase().localeCompare(b.target.toLowerCase()) ||
      b.lastAccessedAt.localeCompare(a.lastAccessedAt),
  );
}

/** How long a session stays "current" in the rail after you last entered it. */
export const RAIL_RECENT_MS = 14 * 24 * 60 * 60_000;

/**
 * Split the rail into what matters now and the rest. People accumulate
 * hundreds of sessions (365 on one real machine); a stable order over ALL
 * of them with a cap showed whichever projects sort first alphabetically
 * and hid the active ones. "Current" = entered in the last 14 days, OR
 * reporting a status, OR with a live terminal — each group in the stable
 * order. Archived sessions are in neither.
 */
export function railSessions(
  sessions: SessionSummary[],
  now: number = Date.now(),
): { current: SessionSummary[]; older: SessionSummary[] } {
  const current: SessionSummary[] = [];
  const older: SessionSummary[] = [];
  for (const s of sessions) {
    if (isArchived(s)) continue;
    const recent = now - (Date.parse(s.lastAccessedAt) || 0) < RAIL_RECENT_MS;
    const live = !!s.attention || s.ptyStatus === 'running' || s.activityState === 'active' || s.activityState === 'open';
    (recent || live ? current : older).push(s);
  }
  return { current: stableSessionOrder(current), older: stableSessionOrder(older) };
}

/** Open PRs for a session, from the PRs pane data. Groups can't be matched
 *  to a sub-repo alias reliably, so any same-branch PR counts for them. */
export function prsForSession(s: SessionSummary, prs: PrInfo[]): PrInfo[] {
  return prs.filter(
    (p) => p.branch === s.branch && (p.repoAlias === s.target || s.isGroup),
  );
}

export type PrLookup = (s: SessionSummary) => PrInfo[];

export const CHECKS_GLYPH: Record<PrInfo['checksStatus'], string> = {
  SUCCESS: '✓',
  FAILURE: '✗',
  PENDING: '●',
  NONE: '',
};

/** `+12 −3`, or null when there's nothing to show. */
export function formatDiffStat(s: SessionSummary): string | null {
  const d = s.diffStat;
  if (!d || (d.added === 0 && d.deleted === 0 && d.files === 0)) return null;
  return `+${d.added} −${d.deleted}`;
}
