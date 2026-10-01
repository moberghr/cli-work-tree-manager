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

export function compareAttention(
  a: AttentionLike | null | undefined,
  b: AttentionLike | null | undefined,
): number {
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
}

/**
 * The inbox's sections, with review feedback — the same order the status
 * vocabulary colours by (session-view.ts `displayStatus`):
 *   0 needs input      — blocked on you
 *   1 done, unseen     — finished a turn you haven't looked at
 *   2 review comments  — reviewers left unresolved comments on its PR(s),
 *                        and its Claude isn't mid-turn
 *   3 working
 *   4 quiet
 *   5 no status, no review comments
 */
export function inboxRank(s: InboxSubject): number {
  if (s.snoozed) return 6;
  const a = s.attention;
  if (a?.state === 'needs_input') return 0;
  if (a?.state === 'idle' && !a.seen) return 1;
  if (a?.state !== 'working' && (s.openReviewThreads ?? 0) > 0) return 2;
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

/** Wants you now — what the Inbox badge counts: needs input, done unseen, review comments. */
export function wantsYou(s: InboxSubject): boolean {
  return inboxRank(s) <= 2;
}

/** The line Claude starts when it stops to ask you something (the PR
 *  watch's CI / review notes ask for it). A finished turn carrying it is
 *  "needs input", not "done": top of the Inbox, and it notifies as such. */
export const DECISION_MARKER = 'DECISION NEEDED:';
