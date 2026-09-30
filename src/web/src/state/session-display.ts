import type { SessionSummary } from '../api/client.js';
import type { PrInfo } from '../api/panes.js';
import type { SessionSubTab } from './dashboard-route.js';

// The status vocabulary (Needs your input / Working / Idle / Stale, the age
// sections) lives in core, shared with `work sessions`.
export * from '../../../core/session-view.js';
import { displayStatus, lastActiveAt } from '../../../core/session-view.js';
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

/**
 * Does a session match the search box? Every word must appear somewhere in
 * its branch, repo, folder, status summary or Jira key (any order, any case)
 * — the folder too, since a repo's alias and folder name can differ
 * (`straumur-backend` lives in `straumur-backend-ai`).
 */
export function sessionMatches(s: SessionSummary, query: string): boolean {
  const words = query.toLowerCase().replace(/\\/g, '/').split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [s.branch, s.target, ...s.paths, s.title ?? '', s.attention?.summary ?? '', s.jiraKey ?? '', s.archive?.lastSummary ?? '', ...(s.archive?.prompts ?? [])]
    .join('\n')
    .toLowerCase()
    .replace(/\\/g, '/');
  return words.every((w) => hay.includes(w));
}

/** A session untouched this long, with no open PR, is worth archiving. */
export const STALE_SUGGEST_MS = 14 * 24 * 60 * 60_000;

/**
 * Sessions to suggest archiving: untouched two weeks or more, no open PR
 * (a PR waiting on review is still going somewhere), no Claude running, and
 * not snoozed ("Not now") in this window. Oldest first.
 *
 * "No open PR" needs a full answer: before the first PR list arrives, when
 * gh failed, or for a repo it couldn't list in full, an empty list means
 * "don't know", and nothing is suggested (`prsKnown`).
 */
export function staleSuggestions(
  sessions: SessionSummary[],
  prsFor: PrLookup | undefined,
  now: number = Date.now(),
  snoozedUntil: Record<string, number> = {},
  prsKnown: (s: SessionSummary) => boolean = () => false,
): SessionSummary[] {
  return sessions
    .filter((s) => {
      if (isArchived(s) || s.claudes) return false;
      if ((snoozedUntil[s.id] ?? 0) > now) return false;
      if (now - Date.parse(lastActiveAt(s)) < STALE_SUGGEST_MS) return false;
      if (!prsFor || !prsKnown(s)) return false;
      return prsFor(s).length === 0;
    })
    .sort((a, b) => lastActiveAt(a).localeCompare(lastActiveAt(b)));
}

/** Open PRs for a session, from the PRs pane data. Groups can't be matched
 *  to a sub-repo alias reliably, so any same-branch PR counts for them. */
export function prsForSession(s: SessionSummary, prs: PrInfo[]): PrInfo[] {
  return prs.filter(
    (p) => p.branch === s.branch && (p.repoAlias === s.target || s.isGroup),
  );
}

export type PrLookup = (s: SessionSummary) => PrInfo[];

/**
 * Whether the PR list is a full answer for a session: a list arrived, and
 * gh listed its repo in full (`incomplete` = repos it couldn't; null = no
 * full answer yet). A group's sub-repos aren't known here, so it needs every
 * repo listed in full.
 */
export function prsKnownFrom(incomplete: string[] | null): (s: SessionSummary) => boolean {
  return (s) => incomplete !== null && (s.isGroup ? incomplete.length === 0 : !incomplete.includes(s.target));
}

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
