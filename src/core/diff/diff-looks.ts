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

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isTurn = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function isLook(v: unknown): v is DiffLook {
  const o = v as DiffLook | null;
  return (
    !!o &&
    typeof o === 'object' &&
    isTurn(o.from) &&
    isTurn(o.to) &&
    o.to > o.from &&
    isTime(o.startedAt) &&
    isTime(o.at) &&
    (o.fromTs === undefined || isTime(o.fromTs)) &&
    (o.toTs === undefined || isTime(o.toTs))
  );
}

/** A stored mark as read back (`unknown`): shape-checked, a bad turn time dropped, only well-formed looks kept. Null when it isn't a mark. */
export function cleanSeen(v: unknown): DiffSeen | null {
  const o = v as DiffSeen | null;
  if (!o || typeof o !== 'object' || !isTurn(o.checkpointId) || !isTime(o.at)) return null;
  const looks = Array.isArray(o.looks) ? o.looks.filter(isLook) : [];
  return {
    checkpointId: o.checkpointId,
    at: o.at,
    ...(isTime(o.ts) ? { ts: o.ts } : {}),
    ...(looks.length ? { looks } : {}),
  };
}

/**
 * Whether the scope was re-baselined since the mark: turn numbers start over (a
 * rebase, or main merged in, brought other work), so a number at or below the mark
 * is a newer turn when its own time is later than the marked turn's.
 */
function rebaselined(old: DiffSeen, checkpointId: number, ts: string | undefined, marked: MarkedTurn | undefined): boolean {
  // The page's word: the marked turn's number now names another turn, or none (its numbering passed the mark's).
  if (marked && old.ts && marked.checkpointId === old.checkpointId && marked.ts !== old.ts) return true;
  return checkpointId <= old.checkpointId && !!ts && !!old.ts && Date.parse(ts) > Date.parse(old.ts);
}

/** A request's `marked`, checked (undefined when it isn't one). */
export function markedTurn(v: unknown): MarkedTurn | undefined {
  const o = v as MarkedTurn | null;
  if (!o || typeof o !== 'object' || !isTurn(o.checkpointId)) return undefined;
  if (o.ts !== null && !isTime(o.ts)) return undefined;
  return { checkpointId: o.checkpointId, ts: o.ts };
}

/** What the page sees now for the mark's turn number: its time, or null when the list has no such turn. */
export interface MarkedTurn {
  checkpointId: number;
  ts: string | null;
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
export function nextSeen(old: DiffSeen | null, checkpointId: number, now: Date, ts?: string, marked?: MarkedTurn): DiffSeen {
  const fresh = !!old && rebaselined(old, checkpointId, ts, marked);
  if (old && old.checkpointId >= checkpointId && !fresh) return old;
  // A turn older than the marked one is behind it, whatever its number: a window still showing the diff from
  // before a re-baseline (higher numbers, the old numbering) never takes the mark back.
  if (old?.ts && ts && Date.parse(ts) < Date.parse(old.ts)) return old;
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
