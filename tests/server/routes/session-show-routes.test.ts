import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountSessionShowRoutes } from '../../../src/server/routes/session-show-routes.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import type { SessionShownWire } from '../../../src/core/api-types.js';

/** A file a session shows beside its terminal: show it (by absolute path, as `work show` does), read which, close it. */
let home: string;
let wt: string;
let id: string;
let archivedId: string;
let events: string[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-show-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  wt = path.join(home, 'wt');
  fs.mkdirSync(path.join(wt, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'docs', 'spec.md'), '# Spec\n');
  fs.writeFileSync(path.join(wt, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const live: WorktreeSession = { target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: 'x', lastAccessedAt: 'x' };
  const archived: WorktreeSession = { ...live, branch: 'feat/old', archivedAt: '2026-11-01T00:00:00Z' };
  saveHistory([live, archived]);
  id = sessionIdFor(live);
  archivedId = sessionIdFor(archived);
  events = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The Code tab's check, without git: a file that exists under the worktree and isn't named "ignored". */
function app() {
  const a = new Hono();
  mountSessionShowRoutes(a, {
    broadcast: (e) => void events.push(e),
    locate: async (s, repo, rel) => {
      const full = path.join(s.paths[0], rel);
      if (repo !== 'wt' || rel.includes('ignored') || !fs.existsSync(full)) return { error: 'not listed' };
      return { real: full, size: fs.statSync(full).size };
    },
  });
  return a;
}
const post = (a: Hono, body: unknown, session = id) =>
  a.request(`/api/sessions/${session}/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = async (a: Hono) => (await (await a.request(`/api/sessions/${id}/show`)).json()) as SessionShownWire;

describe('session show routes', () => {
  it('nothing until shown; an absolute path inside the session shows it, with how it is drawn, and tells the pages', async () => {
    const a = app();
    expect(await get(a)).toEqual({ shown: null });
    const res = await post(a, { file: path.join(wt, 'docs', 'spec.md') });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionShownWire).shown).toMatchObject({ repo: 'wt', path: 'docs/spec.md', kind: 'markdown' });
    expect((await get(a)).shown?.path).toBe('docs/spec.md');
    expect(events).toEqual(['session-show-changed']);
    // By repo and path too (the page's own way).
    expect(((await (await post(a, { repo: 'wt', path: 'shot.png' })).json()) as SessionShownWire).shown).toMatchObject({ kind: 'image' });
  });

  it('refuses a file outside the session, one git ignores or that isn’t there, a body with no file, an archived or unknown session', async () => {
    const a = app();
    expect((await post(a, { file: path.join(home, 'elsewhere.md') })).status).toBe(404);
    expect((await post(a, { file: path.join(wt, '..', 'wt-secrets', 'key.pem') })).status).toBe(404);
    const ignored = await post(a, { file: path.join(wt, 'ignored.md') });
    expect(ignored.status).toBe(404);
    expect(((await ignored.json()) as { error: string }).error).toContain('git ignores it');
    expect((await post(a, {})).status).toBe(400);
    expect((await post(a, { file: path.join(wt, 'docs', 'spec.md') }, archivedId)).status).toBe(409);
    expect((await post(a, { file: 'x' }, 'nope')).status).toBe(404);
    // Nothing was shown, nothing announced.
    expect(await get(a)).toEqual({ shown: null });
    expect(events).toEqual([]);
  });

  it('close takes it away, by DELETE or by `work show --close` (a POST)', async () => {
    const a = app();
    await post(a, { file: path.join(wt, 'docs', 'spec.md') });
    expect((await (await a.request(`/api/sessions/${id}/show`, { method: 'DELETE' })).json()) as SessionShownWire).toEqual({ shown: null });
    await post(a, { file: path.join(wt, 'docs', 'spec.md') });
    expect(((await (await post(a, { close: true })).json()) as SessionShownWire).shown).toBeNull();
    expect(await get(a)).toEqual({ shown: null });
  });

  it('serves the shown file’s bytes only when it is an image, never to be sniffed or run', async () => {
    const a = app();
    expect((await a.request(`/api/sessions/${id}/show/image`)).status).toBe(404);
    await post(a, { file: path.join(wt, 'docs', 'spec.md') });
    expect((await a.request(`/api/sessions/${id}/show/image`)).status).toBe(404);
    await post(a, { file: path.join(wt, 'shot.png') });
    const res = await a.request(`/api/sessions/${id}/show/image`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(new Uint8Array(await res.arrayBuffer())).toHaveLength(7);
    // Deleted meanwhile: gone, not an error page.
    fs.rmSync(path.join(wt, 'shot.png'));
    expect((await a.request(`/api/sessions/${id}/show/image`)).status).toBe(404);
  });
});
