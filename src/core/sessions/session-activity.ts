import { agentOf } from '../agents/index.js';
import type { ActivityState } from '../api-types.js';
import type { WorktreeSession } from './session-types.js';

/**
 * How recently a session's agent wrote: the newest of its conversation files
 * (agents/: `conversation.files`). Works however the agent was started — by
 * `work tree`, `work attach`, a plain terminal or the PTY host — since they
 * all write the same files. An agent work can't read gives no activity (the
 * other signals — hooks, the PTY host's output — still do).
 */

/** Active: it wrote in the last 30 s — mid-turn. */
const ACTIVE_MS = 30_000;
/** Open: it wrote within 5 min — likely still at its prompt. After that, stale. */
const OPEN_MS = 5 * 60_000;

export interface SessionActivity {
  /** ms since epoch of its newest conversation write, or null when there is none. */
  lastActivity: number | null;
  state: ActivityState;
}

/** The newest write to any of the session's conversation files, ms (0: none). */
export function lastConversationWriteMs(session: WorktreeSession): number {
  let latest = 0;
  for (const f of agentOf(session).conversation?.files(session) ?? []) if (f.mtimeMs > latest) latest = f.mtimeMs;
  return latest;
}

export function readSessionActivity(session: WorktreeSession, now = Date.now()): SessionActivity {
  const latest = lastConversationWriteMs(session);
  if (latest === 0) return { lastActivity: null, state: 'stale' };
  const age = now - latest;
  return { lastActivity: latest, state: age <= ACTIVE_MS ? 'active' : age <= OPEN_MS ? 'open' : 'stale' };
}

/**
 * True when an agent wrote within `windowMs` of `nowMs` (0: never). The
 * scope auto-snapshot timer uses it to stay out of the way while an agent is
 * at work (its turn-end hook owns checkpoints then); the timer only fires for
 * hand edits when none is.
 */
export function activeWithin(activityMs: number, nowMs: number, windowMs: number): boolean {
  return activityMs > 0 && nowMs - activityMs < windowMs;
}

/** When it was last used: the newer of its recorded entry and its agent's last write. */
export function effectiveLastAccessedAt(session: WorktreeSession): string {
  const recorded = Date.parse(session.lastAccessedAt);
  return new Date(Math.max(Number.isFinite(recorded) ? recorded : 0, lastConversationWriteMs(session))).toISOString();
}
