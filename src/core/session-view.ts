import type { SessionAttention, ActivityState } from './api-types.js';

/** What the status vocabulary reads from a session: a dashboard row or
 *  a `work sessions` row (both are SessionWire-shaped). */
export interface SessionLike {
  lastAccessedAt: string;
  lastActivity?: number | null;
  activityState?: ActivityState;
  attention?: SessionAttention | null;
  /** Unresolved review threads on its open PRs (SessionWire). */
  openReviewThreads?: number;
}

/**
 * ONE status vocabulary for every view — pure, so the dashboard (it imports
 * this) and `work sessions` say the same thing — (rail, Sessions table, inbox, header
 * strip). Hook-driven attention wins when a session has it; otherwise we fall
 * back to the older transcript-activity signal, so a session never shows two
 * contradicting states in two places.
 *
 *   needs_input — blocked on you (permission / question)
 *   done        — finished a turn you haven't looked at
 *   working     — mid-turn
 *   review      — nothing running for you to answer, but reviewers left
 *                 unresolved comments on its open PR(s)
 *   quiet       — finished, and you've seen it
 *   active/open/recent/stale — no hook status yet (its Claude has not
 *     taken a turn since the dashboard's hooks went in, or runs a tool
 *     without them): transcript activity only. Active ≤ 30 s, Open ≤ 5 min,
 *     Idle (recent) within a day, Stale after that.
 */
export type DisplayKind =
  | 'needs_input'
  | 'done'
  | 'working'
  | 'review'
  | 'quiet'
  | 'active'
  | 'open'
  | 'recent'
  | 'stale';

/** Used today = not stale, whatever the hooks know. */
export const RECENT_MS = 24 * 3_600_000;

/** When the session last did anything: the newest of its hook update,
 *  Claude's last transcript write and the `work tree` entry. (Reading only
 *  the entry time called a session Active and "1d" at once.) */
export function lastActiveAt(s: SessionLike): string {
  const candidates = [Date.parse(s.lastAccessedAt) || 0, s.lastActivity ?? 0, s.attention ? Date.parse(s.attention.updatedAt) || 0 : 0];
  return new Date(Math.max(...candidates)).toISOString();
}

export function displayStatus(s: SessionLike, now: number = Date.now()): DisplayKind {
  const a = s.attention;
  if (a) {
    if (a.state === 'needs_input') return 'needs_input';
    if (a.state === 'working') return 'working';
    if (!a.seen) return 'done';
  }
  if ((s.openReviewThreads ?? 0) > 0) return 'review';
  if (a) return 'quiet';
  if (s.activityState === 'active') return 'active';
  if (s.activityState === 'open') return 'open';
  return now - Date.parse(lastActiveAt(s)) < RECENT_MS ? 'recent' : 'stale';
}

export const DISPLAY_LABEL: Record<DisplayKind, string> = {
  needs_input: 'Needs your input',
  done: 'Done',
  working: 'Working',
  review: 'Review comments',
  quiet: 'Idle',
  active: 'Active',
  open: 'Open',
  recent: 'Idle',
  stale: 'Stale',
};

/** How long ago a session was used, for the Sessions table's sections. */
export type AgeBucket = 'now' | 'week' | 'older';

export const AGE_LABEL: Record<AgeBucket, string> = {
  now: 'Now',
  week: 'This week',
  older: 'Older',
};

export const WEEK_MS = 7 * 24 * 3_600_000;

/** Now: wants you, is working, or was used in the last day. This week:
 *  used within 7 days. Older: everything else — cleanup material. */
export function ageBucket(s: SessionLike, now: number = Date.now()): AgeBucket {
  const kind = displayStatus(s, now);
  if (kind === 'needs_input' || kind === 'done' || kind === 'working' || kind === 'review' || kind === 'active' || kind === 'open') return 'now';
  const age = now - Date.parse(lastActiveAt(s));
  if (age < RECENT_MS) return 'now';
  return age < WEEK_MS ? 'week' : 'older';
}

/** Coarse buckets the Sessions header counts and filters by. */
export type StatusBucket = 'needs' | 'working' | 'idle' | 'stale';

export function statusBucket(kind: DisplayKind): StatusBucket {
  switch (kind) {
    case 'needs_input':
    case 'done':
    case 'review':
      return 'needs';
    case 'working':
    case 'active':
      return 'working';
    case 'quiet':
    case 'open':
    case 'recent':
      return 'idle';
    default:
      return 'stale';
  }
}


/** Why a session shows Active / Open / Idle(recent) / Stale instead of a
 *  real status: its Claude isn't reporting through work web's hooks. */
export const NO_HOOKS_HINT =
  "Its Claude isn't reporting its status (it was started before work web's hooks were installed, or it isn't Claude), so this is from its transcript activity: Active = wrote in the last 30 s, Open = last 5 min. Restart it with `work tree <target> <branch>` (the conversation continues) to get Working / Needs your input / Done.";

/** The hint for a status that comes from activity only; undefined otherwise. */
export function statusHint(kind: DisplayKind): string | undefined {
  return kind === 'active' || kind === 'open' || kind === 'recent' || kind === 'stale' ? NO_HOOKS_HINT : undefined;
}
