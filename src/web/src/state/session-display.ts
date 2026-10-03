import type { SessionSummary } from '../api/client.js';
import type { PrInfo } from '../api/panes.js';
import type { SessionSubTab } from './dashboard-route.js';

// The status vocabulary (Needs your input / Working / Idle / Stale, the age
// sections) lives in core, shared with `work sessions`.
export * from '../../../core/sessions/session-view.js';
import { displayStatus } from '../../../core/sessions/session-view.js';
import { applyManualOrder } from '../../../core/rail/session-order.js';
import { groupRail, type RailGroup, type RailLayout } from '../../../core/rail/rail-layout.js';

/** Where opening a session should land: its terminal — except finished
 *  work you haven't looked at yet, which opens on the diff to review. */
export function defaultSubTab(s: SessionSummary): SessionSubTab {
  return displayStatus(s) === 'done' ? 'diff' : 'term';
}

/** The session's agent as you'd name it ("Claude Code"); a row from a server before agents had names: Claude. */
export function agentName(s: Pick<SessionSummary, 'agent'>): string {
  return s.agent?.name ?? 'Claude';
}

/** Whether work can do this with the session's agent (a row from before: what Claude could). */
export function agentCan(s: Pick<SessionSummary, 'agent'>, what: keyof NonNullable<SessionSummary['agent']>['can']): boolean {
  return s.agent ? s.agent.can[what] : true;
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
    (a, b) => a.target.toLowerCase().localeCompare(b.target.toLowerCase()) || b.lastAccessedAt.localeCompare(a.lastAccessedAt),
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
 * What the rail shows, in groups (Pinned, your sections, the rest): the
 * current sessions, plus — while the older ones are folded away — the
 * pinned ones and the selected one, which always stay visible. `hidden`:
 * how many older ones the "+N older" button stands for.
 */
export function railGroups(
  sessions: SessionSummary[],
  opts: { now?: number; order?: readonly string[]; layout: RailLayout; activeId?: string | null; showOlder?: boolean },
): { groups: RailGroup<SessionSummary>[]; hidden: number } {
  const { current, older } = railSessions(sessions, opts.now ?? Date.now(), opts.order ?? []);
  const kept = opts.showOlder ? older : older.filter((s) => s.id === opts.activeId || opts.layout.places[s.id]?.pinned);
  return { groups: groupRail([...current, ...kept], opts.layout), hidden: older.length - kept.length };
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
  const hay = [
    s.branch,
    s.target,
    ...s.paths,
    s.title ?? '',
    s.attention?.summary ?? '',
    s.jiraKey ?? '',
    s.archive?.lastSummary ?? '',
    ...(s.archive?.prompts ?? []),
  ]
    .join('\n')
    .toLowerCase()
    .replace(/\\/g, '/');
  return words.every((w) => hay.includes(w));
}

/**
 * Open PRs for a session: on its branch, in its repo — or, for a group, in
 * one of the group's repos (`membersOf`: the configured groups, /api/projects).
 * A group whose members aren't known yet takes any same-branch PR, as
 * before the list arrives.
 */
export function prsForSession(s: SessionSummary, prs: PrInfo[], membersOf?: (group: string) => string[] | undefined): PrInfo[] {
  const members = s.isGroup ? membersOf?.(s.target) : undefined;
  return prs.filter(
    (p) => p.branch === s.branch && (p.repoAlias === s.target || (s.isGroup && (!members || members.includes(p.repoAlias)))),
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
