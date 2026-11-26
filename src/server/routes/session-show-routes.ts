import path from 'node:path';
import type { Hono } from 'hono';
import type { CodeFileWire, SessionShownWire } from '../../core/api-types.js';
import { agentOf } from '../../core/agents/index.js';
import {
  createShownFiles,
  findTempFile,
  imageType,
  locateInSession,
  readShownFile,
  shownAbsolute,
  shownKind,
  type ShownFile,
} from '../../core/sessions/shown-file.js';
import type { WorktreeSession } from '../../core/sessions/session-types.js';
import { findSession } from '../../core/sessions/web-state.js';
import { codeFilePath, MAX_CODE_FILE_BYTES } from '../../core/worktree/code-browse.js';

/** An image larger than this isn't served to the pane. */
export const MAX_SHOWN_IMAGE_BYTES = 20 * 1024 * 1024;
/** An HTML page larger than this isn't drawn (an artifact with its libraries inlined is a few hundred KB). */
export const MAX_SHOWN_PAGE_BYTES = 5 * 1024 * 1024;

/**
 * The sandbox a shown HTML page runs in — the response's CSP and the frame's attribute alike: its scripts run (an
 * artifact is often interactive) in an opaque origin of its own (no `allow-same-origin`), so it can't reach the
 * dashboard's page, cookies, storage or terminals; no top navigation. Its requests to work web are cross-origin: it
 * can never read an answer (no route sends CORS headers, `tests/server/no-cors.test.ts`), and refuseReason refuses them
 * anyway (§1.5: `Sec-Fetch-Site: cross-site`, `Origin: null`). It can reach the internet, as the same file opened in a
 * browser does.
 */
export const SHOWN_PAGE_SANDBOX = 'allow-scripts allow-popups allow-forms';

/**
 * A file a session shows beside its terminal (core/sessions/shown-file.ts):
 *
 *   GET    /api/sessions/:id/show         SessionShownWire: what it shows, or nothing (a read)
 *   POST   /api/sessions/:id/show         {file} (an absolute path: `work show`, a click in the terminal) or {repo, path}:
 *                                         show it; {close: true}: stop
 *   DELETE /api/sessions/:id/show         stop showing it
 *   GET    /api/sessions/:id/show/text    a scratch file's text, as the Code tab's read answers (a read)
 *   GET    /api/sessions/:id/show/image   the shown file's bytes, when it is an image (a read)
 *   GET    /api/sessions/:id/show/page    the shown HTML, sandboxed (a read)
 *
 * Only a file the Code tab lists (`codeFilePath`: inside the session's folders, not ignored by git, no link out), or
 * one in its agent's own scratch folders (`tempFolders`, `findTempFile`: on the real path). Every read checks again and
 * serves only the file shown now: the browser names no path. A change is announced with `session-show-changed`.
 */
export interface SessionShowDeps {
  broadcast: (event: string, data: unknown) => void;
  /** Where a listed file is on disk, or why it isn't shown (default: the Code tab's check). */
  locate?: (session: WorktreeSession, repo: string, rel: string) => Promise<{ real: string; size: number } | { error: string }>;
  /** The agent's scratch folders for the session (default: its adapter's `tempFolders`). */
  tempFolders?: (session: WorktreeSession) => string[];
}

export function mountSessionShowRoutes(app: Hono, deps: SessionShowDeps): { drop: (sessionId: string) => void } {
  const shown = createShownFiles({ onChange: (sessionId) => deps.broadcast('session-show-changed', { sessionId }) });
  const locate = deps.locate ?? ((s, repo, rel) => codeFilePath(s, repo, rel));
  const tempFolders = deps.tempFolders ?? ((s) => agentOf(s).tempFolders?.(s) ?? []);
  /** The shown file as it is on disk now, by the rule it was shown under. */
  const where = (s: WorktreeSession, f: ShownFile) => (f.temp ? findTempFile(f.temp, tempFolders(s)) : locate(s, f.repo, f.path));
  const wire = (id: string): SessionShownWire => {
    const f = shown.get(id);
    const s = findSession(id);
    if (!f || !s) return { shown: null };
    const abs = shownAbsolute(s, f);
    return { shown: { ...f, kind: shownKind(f.path), ...(abs ? { abs } : {}) } };
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
    const file = typeof body.file === 'string' && body.file ? body.file : null;
    const at = file
      ? locateInSession(session, file)
      : typeof body.repo === 'string' && typeof body.path === 'string' && body.path
        ? { repo: body.repo, path: body.path.replace(/\\/g, '/') }
        : undefined;
    if (at === undefined) return c.json({ error: 'file (an absolute path), or repo and path' }, 400);
    if (!at) {
      // Not in the session's folders: its agent's scratch folders, where an artifact's HTML is written.
      const temp = file ? await findTempFile(file, tempFolders(session)) : { error: 'outside' };
      if ('error' in temp)
        return c.json({ error: 'That file is not in one of this session’s folders, nor in its agent’s scratch folder.' }, 404);
      shown.show(id, { repo: '', path: path.basename(temp.real), temp: temp.real });
      return c.json(wire(id));
    }
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

  // A scratch file's text (a listed one is read through the Code tab's route): the Code tab's answer, the same limits.
  app.get('/api/sessions/:id/show/text', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    const f = shown.get(id);
    if (!session || !f?.temp) return c.json({ error: 'it shows no scratch file' }, 404);
    const found = await findTempFile(f.temp, tempFolders(session));
    if ('error' in found) return c.json({ error: 'not there any more' }, 404);
    const base: Omit<CodeFileWire, 'text'> = { repo: '', path: f.path, size: found.size };
    if (found.size > MAX_CODE_FILE_BYTES) return c.json({ ...base, text: null, reason: 'too-large' } satisfies CodeFileWire);
    const read = await readShownFile(found.real, MAX_CODE_FILE_BYTES);
    if ('error' in read)
      return read.error === 'too large'
        ? c.json({ ...base, text: null, reason: 'too-large' } satisfies CodeFileWire)
        : c.json({ error: 'not there any more' }, 404);
    const buf = read.bytes;
    if (buf.subarray(0, 8000).includes(0)) return c.json({ ...base, text: null, reason: 'binary' } satisfies CodeFileWire);
    return c.json({ ...base, text: buf.toString('utf-8') } satisfies CodeFileWire);
  });

  app.get('/api/sessions/:id/show/image', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    const f = shown.get(id);
    const type = f ? imageType(f.path) : null;
    if (!session || !f || !type) return c.json({ error: 'it shows no image' }, 404);
    const found = await where(session, f);
    if ('error' in found) return c.json({ error: 'not there any more' }, 404);
    const read = await readShownFile(found.real, MAX_SHOWN_IMAGE_BYTES);
    if ('error' in read)
      return read.error === 'too large' ? c.json({ error: 'too large to show' }, 413) : c.json({ error: 'not there any more' }, 404);
    const bytes = read.bytes;
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

  // The shown HTML, as a page of its own: sandboxed by the response itself, whoever frames or opens it.
  app.get('/api/sessions/:id/show/page', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    const f = shown.get(id);
    if (!session || !f || shownKind(f.path) !== 'html') return c.json({ error: 'it shows no page' }, 404);
    const found = await where(session, f);
    if ('error' in found) return c.json({ error: 'not there any more' }, 404);
    const read = await readShownFile(found.real, MAX_SHOWN_PAGE_BYTES);
    if ('error' in read)
      return read.error === 'too large' ? c.json({ error: 'too large to show' }, 413) : c.json({ error: 'not there any more' }, 404);
    const bytes = read.bytes;
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `sandbox ${SHOWN_PAGE_SANDBOX}`,
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    });
  });

  return { drop: (sessionId) => void shown.close(sessionId) };
}
