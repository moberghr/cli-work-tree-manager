import type { Hono } from 'hono';
import { readNote, saveNote, MAX_NOTE_CHARS } from './session-notes.js';
import { findSession } from './web-state.js';
import type { NoteWire } from './api-types.js';

/**
 * Your notes on a session (session-notes.ts):
 *
 *   GET /api/sessions/:id/note   {note}  (reads only)
 *   PUT /api/sessions/:id/note   {text}  sets it; empty removes it
 */
export function mountNoteRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void }): void {
  app.get('/api/sessions/:id/note', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    return c.json({ note: readNote(id) } satisfies NoteWire);
  });

  app.put('/api/sessions/:id/note', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== 'string') return c.json({ error: 'expected {text}' }, 400);
    if (body.text.length > MAX_NOTE_CHARS) return c.json({ error: `at most ${MAX_NOTE_CHARS} characters` }, 400);
    const note = saveNote(id, body.text);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ note } satisfies NoteWire);
  });
}
