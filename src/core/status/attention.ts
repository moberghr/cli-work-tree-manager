/**
 * Attention-inbox ordering, shared by the server (session-status.ts) and the
 * browser SPA. Pure and dependency-free on purpose: the SPA may import it
 * (see the architecture test's allowlist), so it must never pull in Node.
 */

export type AgentState = 'working' | 'needs_input' | 'idle';

export interface AttentionLike {
  state: AgentState;
  seen: boolean;
  /** When the session entered `state` (ISO). */
  since: string;
}

/**
 * Inbox order: who needs you next.
 *   0 needs input  — blocked on you; longest-waiting first
 *   1 done, unseen — finished a turn you haven't looked at; oldest first
 *   2 working      — most recently started first
 *   3 idle, seen   — nothing to do
 *   4 no status yet
 */
export function attentionRank(s: Pick<AttentionLike, 'state' | 'seen'> | null | undefined): number {
  if (!s) return 4;
  if (s.state === 'needs_input') return 0;
  if (s.state === 'idle' && !s.seen) return 1;
  if (s.state === 'working') return 2;
  return 3;
}

export function compareAttention(a: AttentionLike | null | undefined, b: AttentionLike | null | undefined): number {
  const ra = attentionRank(a);
  const rb = attentionRank(b);
  if (ra !== rb) return ra - rb;
  if (!a || !b) return 0;
  const ta = Date.parse(a.since) || 0;
  const tb = Date.parse(b.since) || 0;
  // Waiting on you: oldest first. Working / idle-seen: newest first.
  return ra <= 1 ? ta - tb : tb - ta;
}

/** Wants the user now — what the inbox count counts. */
export function needsAttention(s: Pick<AttentionLike, 'state' | 'seen'> | null | undefined): boolean {
  return attentionRank(s) <= 1;
}

/** What the inbox ranks: Claude's status plus reviewers waiting on the session's PRs. */
export interface InboxSubject {
  attention?: AttentionLike | null;
  /** Snoozed out of the Inbox (snooze.ts): a section of its own, last; it doesn't want you meanwhile. */
  snoozed?: unknown;
  /** Unresolved review threads on its open PRs whose last word isn't yours. */
  openReviewThreads?: number;
  /** What it waits on that isn't done yet (session-blocks.ts): out of the Inbox meanwhile. */
  blockedBy?: readonly unknown[];
  /** Replies to PR review threads drafted and waiting for your Post (pr-replies.ts). */
  replyDrafts?: number;
  /** Where its pull request stands (pr-stage.ts); `seen` once you looked at it there. */
  prStage?: { kind: string; seen?: boolean; prs?: ReadonlyArray<{ kind: string; checks?: string }> } | null;
}

/**
 * What waits on YOU about a session, apart from what its Claude is doing —
 * the second of a session's two signals (its status icon is the first, and
 * says only what Claude is doing). Most pressing first:
 *   turn     — its Claude finished a turn you haven't looked at (to review)
 *   reply    — replies drafted to its PR's review threads, waiting for your Post
 *   thread   — review threads on its open PRs whose last word isn't yours
 *   conflict — a PR of it conflicts with its base
 *   checks   — a PR of it fails its checks
 *   merge    — its PRs are approved with checks passing: ready to merge
 * Every view reads this one list (the rail's badge, the header's Needs you
 * line, the Sessions table, the Inbox), so they can't disagree.
 */
export type OwedKind = 'turn' | 'reply' | 'thread' | 'conflict' | 'checks' | 'merge';
export interface Owed {
  kind: OwedKind;
  count: number;
}

const OPEN_PR = (k: string) => k !== 'merged' && k !== 'closed';

export function owedToYou(s: Pick<InboxSubject, 'attention' | 'openReviewThreads' | 'replyDrafts' | 'prStage'>): Owed[] {
  const out: Owed[] = [];
  // Finished, and you haven't looked: yours to review — not something its Claude is doing (reported: it took the icon).
  if (s.attention?.state === 'idle' && !s.attention.seen) out.push({ kind: 'turn', count: 1 });
  if ((s.replyDrafts ?? 0) > 0) out.push({ kind: 'reply', count: s.replyDrafts! });
  if ((s.openReviewThreads ?? 0) > 0) out.push({ kind: 'thread', count: s.openReviewThreads! });
  const stage = s.prStage;
  if (!stage) return out;
  // Each PR's own stage when the row has them (a group: one conflicts, another fails); else the stage's.
  const prs = stage.prs?.length ? stage.prs : [{ kind: stage.kind }];
  const conflicts = prs.filter((p) => p.kind === 'conflict').length;
  const failing = prs.filter(
    (p) => p.kind !== 'conflict' && OPEN_PR(p.kind) && (p.kind === 'checks_failing' || p.checks === 'fail'),
  ).length;
  if (conflicts) out.push({ kind: 'conflict', count: conflicts });
  if (failing) out.push({ kind: 'checks', count: failing });
  if (stage.kind === 'ready') out.push({ kind: 'merge', count: Math.max(1, prs.filter((p) => p.kind === 'ready').length) });
  return out;
}

/**
 * It wants you in the Inbox for what it owes you: replies to post and
 * unanswered threads until they're done; its PR's state (ready, conflict,
 * failing) until you've looked at that stage (`prWantsYou`).
 */
export function owedInInbox(s: InboxSubject): boolean {
  return (s.replyDrafts ?? 0) > 0 || (s.openReviewThreads ?? 0) > 0 || prWantsYou(s);
}

/**
 * The PR stages that bring a session back (pr-stage.ts STAGE_WANTS_YOU; a
 * test keeps the two equal — this module imports nothing).
 */
export const PR_STAGES_WANTING = ['ready', 'conflict', 'checks_failing'] as const;

/** Its PR wants you and you haven't looked since: ready to merge, a conflict, failing checks. */
export function prWantsYou(s: Pick<InboxSubject, 'prStage'>): boolean {
  return !!s.prStage && !s.prStage.seen && (PR_STAGES_WANTING as readonly string[]).includes(s.prStage.kind);
}

/**
 * The inbox's sections, with review feedback — the same order the status
 * vocabulary colours by (session-view.ts `displayStatus`):
 *   0 needs input      — blocked on you
 *   1 done, unseen     — finished a turn you haven't looked at
 *   2 needs you        — something on its PRs waits on you (`owedInInbox`:
 *                        replies to post, unanswered review threads, a PR
 *                        ready to merge, conflicting or failing — unseen),
 *                        whatever its Claude is doing
 *   3 working
 *   4 quiet
 *   5 no status, no review comments
 *   6 snoozed
 *   7 waiting on other work (blocked by) — unless its Claude asks you something
 */
export function inboxRank(s: InboxSubject): number {
  if (s.snoozed) return 6;
  const a = s.attention;
  if (s.blockedBy?.length && a?.state !== 'needs_input') return 7;
  if (a?.state === 'needs_input') return 0;
  if (a?.state === 'idle' && !a.seen) return 1;
  if (owedInInbox(s)) return 2;
  if (a?.state === 'working') return 3;
  return a ? 4 : 5;
}

/** Inbox order: by section; waiting on you (0–2) oldest first, the rest newest first. */
export function compareInbox(a: InboxSubject, b: InboxSubject): number {
  const ra = inboxRank(a);
  const rb = inboxRank(b);
  if (ra !== rb) return ra - rb;
  const ta = (a.attention && Date.parse(a.attention.since)) || 0;
  const tb = (b.attention && Date.parse(b.attention.since)) || 0;
  return ra <= 2 ? ta - tb : tb - ta;
}

/** It waits on your answer, as the Inbox's first section has it (not snoozed): what flashes the desktop app's taskbar. */
export function waitsOnYou(s: InboxSubject): boolean {
  return inboxRank(s) === 0;
}

/** Wants you now — what the Inbox badge counts: needs input, done unseen, what it owes you (`owedInInbox`). */
export function wantsYou(s: InboxSubject): boolean {
  return inboxRank(s) <= 2;
}

/** The line Claude starts when it stops to ask you something (the PR
 *  watch's CI / review notes ask for it). A finished turn carrying it is
 *  "needs input", not "done": top of the Inbox, and it notifies as such. */
export const DECISION_MARKER = 'DECISION NEEDED:';
