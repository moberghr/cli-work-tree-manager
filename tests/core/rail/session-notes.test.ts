import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { appendNote, readNote, saveNote, sessionsWithNotes, MAX_NOTE_CHARS } from '../../../src/core/rail/session-notes.js';
import { mountNoteRoutes } from '../../../src/server/routes/note-routes.js';
import { removeSession, saveHistory } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';

const now = new Date().toISOString();
const session = { target: 'api', branch: 'feat/n', isGroup: false, paths: ['/wt/n'], createdAt: now, lastAccessedAt: now };
const id = sessionIdFor(session);

describe('session notes (state.db)', () => {
  it('set, add a line, an empty one is none; capped', () => {
    expect(readNote(id)).toBeNull();
    saveNote(id, 'Decided: keep the queue.');
    appendNote(id, 'Tell the reviewer about the retry.');
    expect(readNote(id)?.text).toBe('Decided: keep the queue.\nTell the reviewer about the retry.');
    expect(sessionsWithNotes().has(id)).toBe(true);
    saveNote(id, '   ');
    expect(readNote(id)).toBeNull();
    expect(saveNote(id, 'x'.repeat(MAX_NOTE_CHARS + 50))?.text).toHaveLength(MAX_NOTE_CHARS);
  });

  it('routes: GET reads, PUT sets (every window told), unknown session 404, too long 400', async () => {
    saveHistory([session]);
    const events: string[] = [];
    const app = new Hono();
    mountNoteRoutes(app, { broadcast: (e) => void events.push(e) });
    const put = (body: unknown, sid = id) => app.request(`/api/sessions/${sid}/note`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ text: 'hello' })).status).toBe(200);
    expect(await (await app.request(`/api/sessions/${id}/note`)).json()).toMatchObject({ note: { text: 'hello' } });
    expect(events).toEqual(['sessions-changed']);
    expect((await put({ text: 'x' }, 'nope')).status).toBe(404);
    expect((await put({ text: 'x'.repeat(MAX_NOTE_CHARS + 1) })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });

  it('go with the session', async () => {
    saveHistory([session]);
    saveNote(id, 'gone soon');
    await removeSession(session.target, session.branch);
    expect(readNote(id)).toBeNull();
  });
});
