import type { DiffSeen } from '../api-types.js';
import { json, tx, withDb } from '../platform/db.js';

/**
 * How far you have looked at a session's diff: the newest of its turns
 * (checkpoints) that was on screen when its Diff tab had been open, in a
 * focused window, for a few seconds. The Diff tab's "Since you last looked"
 * is the range from it to the working tree: whatever Claude changed after
 * that, over however many turns — reviewed in the diff, commented on in
 * the terminal, or not commented on at all. One per session in state.db
 * `diff_seen` (schema v8, gone with the session: purgeSessionRows).
 */

function isSeen(v: unknown): v is DiffSeen {
  const o = v as DiffSeen | null;
  return !!o && typeof o === 'object' && typeof o.checkpointId === 'number' && typeof o.at === 'string';
}

export function readDiffSeen(sessionId: string): DiffSeen | null {
  const row = withDb((d) => d.prepare('SELECT data FROM diff_seen WHERE session_id = ?').get(sessionId) as { data: string } | undefined);
  const v = row ? json.parse(row.data) : null;
  return isSeen(v) ? v : null;
}

/**
 * You looked as far as `checkpointId`. Only ever moves forward: a second
 * window still showing an older diff, or a late request, never takes back
 * what you have seen. Returns what is stored after.
 */
export function markDiffSeen(sessionId: string, checkpointId: number, now = new Date()): DiffSeen {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM diff_seen WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const old = row ? json.parse(row.data) : null;
    if (isSeen(old) && old.checkpointId >= checkpointId) return old;
    const seen: DiffSeen = { checkpointId, at: now.toISOString() };
    d.prepare('INSERT OR REPLACE INTO diff_seen (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(seen));
    return seen;
  });
}
