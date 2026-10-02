import { json, tx, withDb } from './db.js';

/**
 * Your notes on a session: a scratchpad of your own (what you decided, what
 * to tell the reviewer, what's next), not part of Claude's conversation —
 * "Send to Claude" hands it over when you want. One per session in state.db
 * `session_notes` (schema v7, gone with the session: purgeSessionRows).
 */

export const MAX_NOTE_CHARS = 20_000;

export interface SessionNote {
  text: string;
  updatedAt: string;
}

function isNote(v: unknown): v is SessionNote {
  const o = v as SessionNote | null;
  return !!o && typeof o === 'object' && typeof o.text === 'string' && typeof o.updatedAt === 'string';
}

export function readNote(sessionId: string): SessionNote | null {
  const row = withDb((d) => d.prepare('SELECT data FROM session_notes WHERE session_id = ?').get(sessionId) as { data: string } | undefined);
  const v = row ? json.parse(row.data) : null;
  return isNote(v) ? v : null;
}

/** Which sessions have a note (for the sessions list: one query). */
export function sessionsWithNotes(): Set<string> {
  const rows = withDb((d) => d.prepare('SELECT session_id FROM session_notes').all() as Array<{ session_id: string }>);
  return new Set(rows.map((r) => r.session_id));
}

/** Set it (trimmed to MAX_NOTE_CHARS); an empty one is removed. */
export function saveNote(sessionId: string, text: string, now = new Date()): SessionNote | null {
  const t = text.slice(0, MAX_NOTE_CHARS);
  if (!t.trim()) {
    withDb((d) => d.prepare('DELETE FROM session_notes WHERE session_id = ?').run(sessionId));
    return null;
  }
  const note = { text: t, updatedAt: now.toISOString() };
  withDb((d) => d.prepare('INSERT OR REPLACE INTO session_notes (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(note)));
  return note;
}

/** Add a line at the end (`work note --append`), in one transaction with the read. */
export function appendNote(sessionId: string, line: string, now = new Date()): SessionNote | null {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM session_notes WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const prev = row ? json.parse(row.data) : null;
    const text = (isNote(prev) && prev.text.trim() ? `${prev.text.replace(/\s+$/, '')}\n` : '') + line;
    const note = { text: text.slice(0, MAX_NOTE_CHARS), updatedAt: now.toISOString() };
    d.prepare('INSERT OR REPLACE INTO session_notes (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(note));
    return note;
  });
}
