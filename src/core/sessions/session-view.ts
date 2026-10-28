import type { SessionAttention, ActivityState } from '../api-types.js';
import { stageWaiting, type PrStageKind } from '../pr/pr-stage.js';
import { owedToYou, type Owed } from '../status/attention.js';

/** What the status vocabulary reads from a session: a dashboard row or
 *  a `work sessions` row (both are SessionWire-shaped). */
export interface SessionLike {
  lastAccessedAt: string;
  lastActivity?: number | null;
  activityState?: ActivityState;
  attention?: SessionAttention | null;
  /** Unresolved review threads on its open PRs (SessionWire). */
  openReviewThreads?: number;
  /** Replies drafted to its review threads, waiting for your Post (SessionWire). */
  replyDrafts?: number;
  /** Where its pull request stands (SessionWire, pr-stage.ts). */
  prStage?: { kind: PrStageKind; text: string; seen?: boolean; prs?: ReadonlyArray<{ kind: PrStageKind; checks?: string }> } | null;
  /** Being archived right now (SessionWire.archiving). */
  archiving?: boolean;
  /** Being restored right now (SessionWire.restoring). */
  restoring?: boolean;
  /** Its Claude was stopped while idle and hasn't run since (SessionWire.asleep). */
  asleep?: boolean;
}

/**
 * ONE status vocabulary for every view — pure, so the dashboard (it imports
 * this) and `work sessions` say the same thing — (rail, Sessions table, inbox, header
 * strip). Hook-driven attention wins when a session has it; otherwise we fall
 * back to the older transcript-activity signal, so a session never shows two
 * contradicting states in two places.
 *
 *   archiving   — being archived right now (its Claude stopped, the rest
 *                 being saved); it leaves the list when done
 *   restoring   — being restored (its worktree made again, the conversation
 *                 put back); in the rail again from the click
 *   needs_input — blocked on you (permission / question)
 *   done        — finished a turn you haven't looked at
 *   working     — mid-turn
 *   background  — its turn ended, a background agent that turn started is
 *                 still at it: still busy, but its prompt is free
 *   asleep      — its Claude was stopped while idle (idle sleep, `work stop`)
 *                 and hasn't run since: opening it starts it again
 *   quiet       — finished, and you've seen it
 *   active/open/recent/stale — no hook status yet (its Claude has not
 *     taken a turn since the dashboard's hooks went in, or runs a tool
 *     without them): transcript activity only. Active ≤ 30 s, Open ≤ 5 min,
 *     Idle (recent) within a day, Stale after that.
 */
export type DisplayKind =
  | 'archiving'
  | 'restoring'
  | 'needs_input'
  | 'done'
  | 'working'
  | 'background'
  | 'asleep'
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
  if (s.archiving) return 'archiving';
  if (s.restoring) return 'restoring';
  const a = s.attention;
  if (a) {
    if (a.state === 'needs_input') return 'needs_input';
    if (a.state === 'working') return a.background ? 'background' : 'working';
    if (!a.seen) return 'done';
  }
  // Below what wants you (a finished turn you haven't seen still says Done): in place of the idle ring.
  if (s.asleep) return 'asleep';
  if (a) return 'quiet';
  if (s.activityState === 'active') return 'active';
  if (s.activityState === 'open') return 'open';
  return now - Date.parse(lastActiveAt(s)) < RECENT_MS ? 'recent' : 'stale';
}

export const DISPLAY_LABEL: Record<DisplayKind, string> = {
  archiving: 'Archiving',
  restoring: 'Restoring',
  needs_input: 'Needs your input',
  done: 'Done',
  working: 'Working',
  background: 'In background',
  asleep: 'Asleep',
  quiet: 'Idle',
  active: 'Active',
  open: 'Open',
  recent: 'Idle',
  stale: 'Stale',
};

/** What each status means, in words — the legend and the dots' tooltips. */
export const DISPLAY_MEANING: Record<DisplayKind, string> = {
  archiving:
    'Being archived: its Claude is stopped, its conversation and uncommitted files are saved, and its worktree goes once nothing would be lost. It leaves the list when done; Restore brings it back.',
  restoring:
    'Being restored: its worktree is made again from its branch, with its uncommitted files and conversation put back. Then it carries on where it was.',
  needs_input: 'Its Claude is waiting for you: a permission prompt or a question.',
  done: "Its Claude finished a turn you haven't looked at yet.",
  working: 'Its Claude is working on your last instruction right now.',
  background:
    'Its Claude finished its turn, and a background agent that turn started is still at work. Its prompt is free: you can talk to it. The agent’s result comes back as a new turn.',
  asleep:
    'Its Claude was stopped to free memory: idle for a while, nothing attached, nothing of it still running. Opening the session starts it again, where it left off.',
  quiet: "Its Claude finished, and you've seen it. Nothing to do.",
  active: "Its Claude wrote in the last 30 seconds (it isn't reporting its status, so this is from its transcript).",
  open: 'Its Claude wrote in the last 5 minutes, or is open and idle at its prompt.',
  recent: 'Used in the last day; nothing running now.',
  stale: 'Not used for over a day.',
};

/** The legend's rows, most urgent first. Idle covers `quiet` and `recent` (same colour, same word). */
export const LEGEND_KINDS: readonly DisplayKind[] = [
  'needs_input',
  'done',
  'working',
  'background',
  'asleep',
  'archiving',
  'restoring',
  'active',
  'open',
  'quiet',
  'stale',
];

/**
 * How full a Claude conversation may get before it matters: past WARN the
 * header shows it amber and the PR watch's notes ask Claude to hand
 * mechanical work to a sub-agent; past FULL it's red (Claude compacts near
 * the window, and answers get vaguer before that).
 */
export const CONTEXT_WARN = 0.7;
export const CONTEXT_FULL = 0.9;

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
  if (owedToYou(s).length) return 'now';
  if (
    kind === 'needs_input' ||
    kind === 'done' ||
    kind === 'working' ||
    kind === 'background' ||
    kind === 'archiving' ||
    kind === 'restoring' ||
    kind === 'active' ||
    kind === 'open'
  )
    return 'now';
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
      return 'needs';
    case 'working':
    case 'background':
    case 'archiving':
    case 'restoring':
    case 'active':
      return 'working';
    case 'quiet':
    case 'asleep':
    case 'open':
    case 'recent':
      return 'idle';
    case 'stale':
      return 'stale';
    default: {
      // Every kind is named above: a new one fails the type check here instead of landing in "stale" unasked.
      const unknown: never = kind;
      return unknown;
    }
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

/**
 * The second signal: what waits on you about a session, beside what its
 * Claude is doing (attention.ts `owedToYou`), in words. The rail's badge is
 * the first thing ("1 reply", "merge"; "+1" when there's more), its tooltip
 * all of them; the Sessions table and the Inbox say the same.
 */
export const OWED_SHORT: Record<Owed['kind'], (n: number) => string> = {
  reply: (n) => `${n} ${n === 1 ? 'reply' : 'replies'}`,
  thread: (n) => `${n} ${n === 1 ? 'thread' : 'threads'}`,
  conflict: () => 'conflict',
  checks: () => 'CI',
  merge: () => 'merge',
};
export const OWED_LONG: Record<Owed['kind'], (n: number) => string> = {
  reply: (n) => `${n} ${n === 1 ? 'reply' : 'replies'} to post`,
  thread: (n) => `${n} review ${n === 1 ? 'thread' : 'threads'} with no answer`,
  conflict: (n) => (n === 1 ? 'a merge conflict' : `${n} PRs with merge conflicts`),
  checks: (n) => (n === 1 ? 'checks failing' : `${n} PRs with checks failing`),
  merge: () => 'ready to merge',
};

export interface OwedBadge {
  /** "1 reply", "merge +1". */
  text: string;
  /** "Needs you: 1 reply to post · ready to merge". */
  title: string;
}

/** The badge for what waits on you, or null when nothing does. */
export function owedBadge(s: SessionLike): OwedBadge | null {
  const owed = owedToYou(s);
  if (!owed.length) return null;
  const [first, ...more] = owed;
  return {
    text: OWED_SHORT[first.kind](first.count) + (more.length ? ` +${more.length}` : ''),
    title: `Needs you: ${owed.map((o) => OWED_LONG[o.kind](o.count)).join(' · ')}`,
  };
}

/** Nothing waits on you, and its PR waits on others (reviewers, checks): "in review", said quietly. */
export function waitingOnOthers(s: SessionLike): boolean {
  return !owedToYou(s).length && stageWaiting(s.prStage);
}

/** The Sessions table's status filter: what waits on you counts as "needs you", whatever Claude is doing. */
export function sessionBucket(s: SessionLike, now: number = Date.now()): StatusBucket {
  return owedToYou(s).length ? 'needs' : statusBucket(displayStatus(s, now));
}
