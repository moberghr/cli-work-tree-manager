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
 * Whether the scope was re-baselined since the mark: turn numbers start over (a
 * rebase, or main merged in, brought other work), so a number at or below the mark
 * is a newer turn when its own time is later than the marked turn's.
 */
function rebaselined(old: DiffSeen, checkpointId: number, ts: string | undefined): boolean {
  return checkpointId <= old.checkpointId && !!ts && !!old.ts && Date.parse(ts) > Date.parse(old.ts);
}

/**
 * The mark after you looked as far as `checkpointId` (a turn of time `ts`):
 * unchanged when that isn't further than it was (a second window on an older diff,
 * a late request); else moved, with the look recorded — or the last one grown, when
 * it ended where this starts within LOOK_JOIN_MS (you stayed while Claude finished
 * more turns). The first look of a session records none (there was no "since" to
 * show), and neither does a move across a re-baseline (the turns before it are
 * gone): the mark starts over in the new numbering.
 */
export function nextSeen(old: DiffSeen | null, checkpointId: number, now: Date, ts?: string): DiffSeen {
  const fresh = !!old && rebaselined(old, checkpointId, ts);
  if (old && old.checkpointId >= checkpointId && !fresh) return old;
  const at = now.toISOString();
  const looks = (old?.looks ?? []).filter(isLook);
  if (old && !fresh) {
    const last = looks.at(-1);
    if (last && last.to === old.checkpointId && last.toTs === old.ts && now.getTime() - Date.parse(last.at) < LOOK_JOIN_MS) {
      looks[looks.length - 1] = { ...last, to: checkpointId, ...(ts ? { toTs: ts } : {}), at };
    } else {
      looks.push({
        from: old.checkpointId,
        to: checkpointId,
        ...(old.ts ? { fromTs: old.ts } : {}),
        ...(ts ? { toTs: ts } : {}),
        startedAt: at,
        at,
      });
    }
  }
  return { checkpointId, at, ...(ts ? { ts } : {}), ...(looks.length ? { looks: looks.slice(-MAX_LOOKS) } : {}) };
}
