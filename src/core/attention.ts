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
