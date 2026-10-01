import { json, withDb } from './db.js';
import type { Snooze } from './snooze.js';

/** Snoozes, one per session, in state.db `session_snooze` (gone with the session: purgeSessionRows). */

function isSnooze(v: unknown): v is Snooze {
  const o = v as Snooze | null;
  return !!o && typeof o === 'object' && (o.until === null || typeof o.until === 'string') && typeof o.at === 'string';
}

export function readSnooze(sessionId: string): Snooze | null {
  const row = withDb((d) => d.prepare('SELECT data FROM session_snooze WHERE session_id = ?').get(sessionId) as { data: string } | undefined);
  const v = row ? json.parse(row.data) : null;
  return isSnooze(v) ? v : null;
}

/** Every session's snooze (one query for the whole session list). */
export function allSnoozes(): Map<string, Snooze> {
  const rows = withDb((d) => d.prepare('SELECT session_id, data FROM session_snooze').all() as Array<{ session_id: string; data: string }>);
  const out = new Map<string, Snooze>();
  for (const r of rows) {
    const v = json.parse(r.data);
    if (isSnooze(v)) out.set(r.session_id, v);
  }
  return out;
}

export function saveSnooze(sessionId: string, snooze: Snooze): void {
  withDb((d) => d.prepare('INSERT OR REPLACE INTO session_snooze (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(snooze)));
}

export function clearSnooze(sessionId: string): boolean {
  return withDb((d) => d.prepare('DELETE FROM session_snooze WHERE session_id = ?').run(sessionId).changes > 0);
}
