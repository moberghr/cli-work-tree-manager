import type { DiffLook, DiffSeen } from '../api-types.js';

/**
 * Your looks at a session's diff, kept so you can see one again: each time the
 * "how far you looked" mark moves forward, from the turn it was at to the turn
 * it moves to — what "Since you looked" showed you then. Kept in the mark's own
 * record (diff-seen.ts), as pointers to turns (checkpoints), never a snapshot of
 * their own: checkpoints are Claude's turns everywhere else. Pure, shared with
 * the demo.
 */

/** Moves this close together are one sitting: the look grows instead of a new one starting. */
export const LOOK_JOIN_MS = 15 * 60_000;
/** Looks kept per session, newest last. */
export const MAX_LOOKS = 20;

export function isLook(v: unknown): v is DiffLook {
  const o = v as DiffLook | null;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.from === 'number' &&
    typeof o.to === 'number' &&
    o.to > o.from &&
    typeof o.startedAt === 'string' &&
    typeof o.at === 'string'
  );
}

/**
 * The mark after you looked as far as `checkpointId`: unchanged when that isn't
 * further than it was (a second window on an older diff, a late request); else
 * moved, with the look recorded — or the last one grown, when it ended where this
 * starts within LOOK_JOIN_MS (you stayed while Claude finished more turns). The
 * first look of a session records none: there was no "since" to show.
 */
export function nextSeen(old: DiffSeen | null, checkpointId: number, now: Date): DiffSeen {
  if (old && old.checkpointId >= checkpointId) return old;
  const at = now.toISOString();
  const looks = (old?.looks ?? []).filter(isLook);
  if (old) {
    const last = looks.at(-1);
    if (last && last.to === old.checkpointId && now.getTime() - Date.parse(last.at) < LOOK_JOIN_MS) {
      looks[looks.length - 1] = { ...last, to: checkpointId, at };
    } else {
      looks.push({ from: old.checkpointId, to: checkpointId, startedAt: at, at });
    }
  }
  return { checkpointId, at, ...(looks.length ? { looks: looks.slice(-MAX_LOOKS) } : {}) };
}
