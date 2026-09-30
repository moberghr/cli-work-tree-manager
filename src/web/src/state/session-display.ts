import type { SessionSummary } from '../api/client.js';
import type { PrInfo } from '../api/panes.js';
import type { SessionSubTab } from './dashboard-route.js';

// The status vocabulary (Needs your input / Working / Idle / Stale, the age
// sections) lives in core, shared with `work sessions`.
export * from '../../../core/session-view.js';
import { displayStatus } from '../../../core/session-view.js';
import { applyManualOrder } from '../../../core/session-order.js';

/** Where opening a session should land: its terminal — except finished
 *  work you haven't looked at yet, which opens on the diff to review. */
export function defaultSubTab(s: SessionSummary): SessionSubTab {
  return displayStatus(s) === 'done' ? 'diff' : 'term';
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
  /** Your drag order (session ids, top first); unplaced ones come first. */
  order: readonly string[] = [],
): { current: SessionSummary[]; older: SessionSummary[] } {
  const current: SessionSummary[] = [];
  const older: SessionSummary[] = [];
  for (const s of sessions) {
    if (isArchived(s)) continue;
    const recent = now - (Date.parse(s.lastAccessedAt) || 0) < RAIL_RECENT_MS;
    const live = !!s.attention || s.ptyStatus === 'running' || s.activityState === 'active' || s.activityState === 'open';
    (recent || live ? current : older).push(s);
  }
  return { current: applyManualOrder(stableSessionOrder(current), order), older: applyManualOrder(stableSessionOrder(older), order) };
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
