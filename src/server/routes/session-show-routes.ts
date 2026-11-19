import fs from 'node:fs';
import type { Hono } from 'hono';
import type { SessionShownWire } from '../../core/api-types.js';
import { createShownFiles, imageType, locateInSession, shownKind } from '../../core/sessions/shown-file.js';
import type { WorktreeSession } from '../../core/sessions/session-types.js';
import { findSession } from '../../core/sessions/web-state.js';
import { codeFilePath } from '../../core/worktree/code-browse.js';

/** An image larger than this isn't served to the pane. */
export const MAX_SHOWN_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * A file a session shows beside its terminal (core/sessions/shown-file.ts):
 *
 *   GET    /api/sessions/:id/show         SessionShownWire: what it shows, or nothing (a read)
 *   POST   /api/sessions/:id/show         {file} (an absolute path: `work show`) or {repo, path}: show it; {close: true}: stop
 *   DELETE /api/sessions/:id/show         stop showing it
 *   GET    /api/sessions/:id/show/image   the shown file's bytes, when it is an image (a read)
 *
 * Only a file the Code tab lists (`codeFilePath`: inside the session's folders, not ignored by git, no link out).
 * Its text is read through the Code tab's own route; a change is announced with `session-show-changed`.
 */
export interface SessionShowDeps {
  broadcast: (event: string, data: unknown) => void;
  /** Where a listed file is on disk, or why it isn't shown (default: the Code tab's check). */
  locate?: (session: WorktreeSession, repo: string, rel: string) => Promise<{ real: string; size: number } | { error: string }>;
}

export function mountSessionShowRoutes(app: Hono, deps: SessionShowDeps): { drop: (sessionId: string) => void } {
  const shown = createShownFiles({ onChange: (sessionId) => deps.broadcast('session-show-changed', { sessionId }) });
  const locate = deps.locate ?? ((s, repo, rel) => codeFilePath(s, repo, rel));
  const wire = (id: string): SessionShownWire => {
    const f = shown.get(id);
    return { shown: f ? { ...f, kind: shownKind(f.path) } : null };
  };

  app.get('/api/sessions/:id/show', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    return c.json(wire(id));
  });

  app.post('/api/sessions/:id/show', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    if (session.archivedAt) return c.json({ error: 'It is archived: restore it first.' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { file?: unknown; repo?: unknown; path?: unknown; close?: unknown };
    // `work show --close`: the command speaks POST only.
    if (body.close === true) {
      shown.close(id);
      return c.json(wire(id));
    }
    const at =
      typeof body.file === 'string' && body.file
        ? locateInSession(session, body.file)
        : typeof body.repo === 'string' && typeof body.path === 'string' && body.path
          ? { repo: body.repo, path: body.path.replace(/\\/g, '/') }
          : undefined;
    if (at === undefined) return c.json({ error: 'file (an absolute path), or repo and path' }, 400);
    if (!at) return c.json({ error: 'That file is not in one of this session’s folders.' }, 404);
    const found = await locate(session, at.repo, at.path);
    if ('error' in found)
      return c.json(
        {
          error:
            found.error === 'not listed'
              ? 'That file isn’t one this session can show: it doesn’t exist, or git ignores it.'
              : `It can’t be shown: ${found.error}.`,
        },
        404,
      );
    shown.show(id, at);
    return c.json(wire(id));
  });

  app.delete('/api/sessions/:id/show', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    shown.close(id);
    return c.json(wire(id));
  });

  app.get('/api/sessions/:id/show/image', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    const f = shown.get(id);
    const type = f ? imageType(f.path) : null;
    if (!session || !f || !type) return c.json({ error: 'it shows no image' }, 404);
    const found = await locate(session, f.repo, f.path);
    if ('error' in found) return c.json({ error: 'not there any more' }, 404);
    if (found.size > MAX_SHOWN_IMAGE_BYTES) return c.json({ error: 'too large to show' }, 413);
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(found.real);
    } catch {
      return c.json({ error: 'not there any more' }, 404);
    }
    // Only ever as that image: never sniffed into something that runs, never framed as a page of ours.
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
      },
    });
  });

  return { drop: (sessionId) => void shown.close(sessionId) };
}
