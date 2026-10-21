import type { Hono } from 'hono';

/**
 * Tell a session's Claude something from inside work web: a published
 * general comment, POSTed to the session's own comments route on this app —
 * so it is delivered like every note (typed into an idle terminal work owns,
 * else on the next turn), never written past that route. Throws when the
 * route refuses it.
 */
export function noteThroughComments(app: Pick<Hono, 'request'>): (sessionId: string, body: string) => Promise<void> {
  return async (sessionId, body) => {
    const res = await app.request(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: 'general', status: 'published', body }),
    });
    if (!res.ok) throw new Error(`posting the note failed: ${res.status}`);
  };
}
