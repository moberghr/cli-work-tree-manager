import type { Hono } from 'hono';
import type { PrReply } from '../../core/api-types.js';
import type { DemoScenario } from './scenario.js';

/**
 * The demo's reply drafts (the real ones: pr-replies.ts): two threads on
 * chore/deps-update's PR — one Claude drafted an answer to, one it is still
 * working on. Posting is simulated.
 */
export function mountDemoReplies(app: Hono, scenario: DemoScenario, emit: (sessionId: string) => void): (sessionId: string) => number {
  const byId = new Map<string, PrReply[]>();
  const deps = scenario.list().find((s) => s.branch === 'chore/deps-update');
  if (deps) {
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    byId.set(deps.id, [
      {
        threadId: 'PRRT_demo_zod',
        repo: 'api',
        prNumber: 212,
        url: 'https://github.com/example/api/pull/212#discussion_r1',
        where: 'src/schema.ts:14',
        reviewer: 'dana',
        excerpt: 'zod 4 changed `.nonempty()` — does this still reject empty arrays?',
        status: 'draft',
        draft: 'Yes — switched to `.min(1)`, which zod 4 keeps, and added a test for the empty case (a1b2c3d).',
        sentAt: at,
        draftedAt: at,
      },
      {
        threadId: 'PRRT_demo_lock',
        repo: 'api',
        prNumber: 212,
        url: 'https://github.com/example/api/pull/212#discussion_r2',
        where: 'package-lock.json',
        reviewer: 'copilot-pull-request-reviewer',
        excerpt: 'The lockfile also bumps `express` to a new major version; was that intended?',
        status: 'sent',
        draft: null,
        sentAt: at,
      },
    ]);
  }
  const list = (id: string) => byId.get(id) ?? [];
  const find = (id: string, thread: string) => list(id).find((r) => r.threadId === thread);

  app.get('/api/sessions/:id/replies', (c) => c.json({ replies: list(c.req.param('id')), waiting: [] }));
  app.put('/api/sessions/:id/replies/:thread', async (c) => {
    const r = find(c.req.param('id'), c.req.param('thread'));
    const b = (await c.req.json().catch(() => ({}))) as { body?: unknown };
    if (!r || typeof b.body !== 'string' || !b.body.trim()) return c.json({ error: 'unknown thread or empty reply' }, 400);
    Object.assign(r, { status: 'draft', draft: b.body.trim(), draftedAt: new Date().toISOString() });
    emit(c.req.param('id'));
    return c.json({ reply: r });
  });
  app.delete('/api/sessions/:id/replies/:thread', (c) => {
    const id = c.req.param('id');
    byId.set(
      id,
      list(id).filter((r) => r.threadId !== c.req.param('thread')),
    );
    emit(id);
    return c.json({ ok: true });
  });
  app.post('/api/sessions/:id/replies/:thread/post', async (c) => {
    const r = find(c.req.param('id'), c.req.param('thread'));
    const b = (await c.req.json().catch(() => ({}))) as { body?: unknown; resolve?: unknown };
    if (!r || typeof b.body !== 'string' || !b.body.trim()) return c.json({ error: 'unknown thread or empty reply' }, 400);
    Object.assign(r, {
      status: 'posted',
      draft: b.body.trim(),
      postedAt: new Date().toISOString(),
      postedUrl: r.url,
      resolved: b.resolve === true,
    });
    emit(c.req.param('id'));
    return c.json({ ok: true, url: r.url, resolved: b.resolve === true });
  });
  app.post('/api/replies-changed', (c) => c.json({ ok: true }));
  // Drafts waiting, for the session rows.
  return (id) => list(id).filter((r) => r.status === 'draft').length;
}
