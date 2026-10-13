import type { DiffSeen } from '../api-types.js';
import { json, tx, withDb } from '../platform/db.js';
import { cleanSeen, nextSeen, type MarkedTurn } from './diff-looks.js';

/**
 * How far you have looked at a session's diff: the newest of its turns
 * (checkpoints) that was on screen when its Diff tab had been open, in a
 * focused window, for a few seconds. The Diff tab's "Since you last looked"
 * is the range from it to the working tree: whatever Claude changed after
 * that, over however many turns — reviewed in the diff, commented on in
 * the terminal, or not commented on at all. One per session in state.db
 * `diff_seen` (schema v8, gone with the session: purgeSessionRows), with your
 * earlier looks in the same record (diff-looks.ts: no schema change).
 */

export function readDiffSeen(sessionId: string): DiffSeen | null {
  const row = withDb((d) => d.prepare('SELECT data FROM diff_seen WHERE session_id = ?').get(sessionId) as { data: string } | undefined);
  return row ? cleanSeen(json.parse(row.data)) : null;
}

/**
 * You looked as far as `checkpointId`. Only ever moves forward: a second
 * window still showing an older diff, or a late request, never takes back
 * what you have seen. Returns what is stored after.
 */
export function markDiffSeen(sessionId: string, checkpointId: number, now = new Date(), ts?: string, marked?: MarkedTurn): DiffSeen {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM diff_seen WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const old = row ? cleanSeen(json.parse(row.data)) : null;
    const seen = nextSeen(old, checkpointId, now, ts, marked);
    if (seen === old) return old;
    d.prepare('INSERT OR REPLACE INTO diff_seen (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(seen));
    return seen;
  });
}
