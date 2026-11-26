import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountSessionShowRoutes, SHOWN_PAGE_SANDBOX } from '../../../src/server/routes/session-show-routes.js';
import { refuseReason } from '../../../src/server/local-origin.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import type { SessionShownWire } from '../../../src/core/api-types.js';

/** A file a session shows beside its terminal: show it (by absolute path, as `work show` does), read which, close it. */
let home: string;
let wt: string;
let scratch: string;
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
  fs.writeFileSync(path.join(wt, 'mock.html'), '<p>listed</p>');
  // The agent's scratch folder for this session (Claude's /tmp/claude-<uid>/<folder>): an artifact's HTML is written there.
  scratch = path.join(home, 'tmp-claude', 'conv', 'scratchpad');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'artifact.html'), '<script>1</script><h1>Artifact</h1>');
  fs.writeFileSync(path.join(scratch, 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(home, 'elsewhere.html'), "not this session's");
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
    // Real folders, as sessionTempFolders names them (macOS's tmpdir is under a link).
    tempFolders: () => [fs.realpathSync(path.join(home, 'tmp-claude'))],
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
    expect(await get(a)).toEqual({ shown: null, pane: null });
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
    expect(await get(a)).toEqual({ shown: null, pane: null });
    expect(events).toEqual([]);
  });

  it('close takes it away, by DELETE or by `work show --close` (a POST)', async () => {
    const a = app();
    await post(a, { file: path.join(wt, 'docs', 'spec.md') });
    expect((await (await a.request(`/api/sessions/${id}/show`, { method: 'DELETE' })).json()) as SessionShownWire).toEqual({
      shown: null,
      pane: null,
    });
    await post(a, { file: path.join(wt, 'docs', 'spec.md') });
    expect(((await (await post(a, { close: true })).json()) as SessionShownWire).shown).toBeNull();
    expect(await get(a)).toEqual({ shown: null, pane: null });
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

  it("a file in its agent's scratch folder (an artifact's HTML) is shown too, with where it is on disk", async () => {
    const a = app();
    const file = path.join(scratch, 'artifact.html');
    const res = await post(a, { file });
    expect(res.status).toBe(200);
    const shown = ((await res.json()) as SessionShownWire).shown!;
    expect(shown).toMatchObject({ repo: '', path: 'artifact.html', kind: 'html', temp: fs.realpathSync(file), abs: fs.realpathSync(file) });
    // A listed file says where it is too (the pane's Open in app / Show in Finder).
    expect(((await (await post(a, { file: path.join(wt, 'docs', 'spec.md') })).json()) as SessionShownWire).shown?.abs).toBe(
      path.join(wt, 'docs', 'spec.md'),
    );
  });

  it('refuses a file outside both, and a link in the scratch folder that points out of it', async () => {
    const a = app();
    expect((await post(a, { file: path.join(home, 'elsewhere.html') })).status).toBe(404);
    fs.symlinkSync(path.join(home, 'elsewhere.html'), path.join(scratch, 'link.html'));
    expect((await post(a, { file: path.join(scratch, 'link.html') })).status).toBe(404);
    expect(await get(a)).toEqual({ shown: null, pane: null });
  });

  it("a scratch file's text, as the Code tab answers; none for a listed file (the Code tab reads that)", async () => {
    const a = app();
    await post(a, { file: path.join(scratch, 'notes.md') });
    const text = await a.request(`/api/sessions/${id}/show/text`);
    expect(text.status).toBe(200);
    expect(await text.json()).toEqual({ repo: '', path: 'notes.md', size: 8, text: '# Notes\n' });
    await post(a, { file: path.join(wt, 'docs', 'spec.md') });
    expect((await a.request(`/api/sessions/${id}/show/text`)).status).toBe(404);
  });

  it('serves the shown HTML only, sandboxed by the response itself: scripts in an origin of their own, never ours', async () => {
    const a = app();
    expect((await a.request(`/api/sessions/${id}/show/page`)).status).toBe(404); // nothing shown
    await post(a, { file: path.join(scratch, 'notes.md') });
    expect((await a.request(`/api/sessions/${id}/show/page`)).status).toBe(404); // not HTML
    await post(a, { file: path.join(scratch, 'artifact.html') });
    const page = await a.request(`/api/sessions/${id}/show/page`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<script>1</script><h1>Artifact</h1>');
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toBe(`sandbox ${SHOWN_PAGE_SANDBOX}`);
    expect(SHOWN_PAGE_SANDBOX.split(' ')).not.toContain('allow-same-origin');
    expect(SHOWN_PAGE_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('cache-control')).toBe('no-store');
    // A listed HTML file is served the same way.
    await post(a, { file: path.join(wt, 'mock.html') });
    expect(await (await a.request(`/api/sessions/${id}/show/page`)).text()).toBe('<p>listed</p>');
  });

  it('every read checks again: a shown scratch file swapped for a link out of it is not served', async () => {
    const a = app();
    const file = path.join(scratch, 'artifact.html');
    await post(a, { file });
    fs.rmSync(file);
    fs.symlinkSync(path.join(home, 'elsewhere.html'), file);
    expect((await a.request(`/api/sessions/${id}/show/page`)).status).toBe(404);
  });

  it("the page's own requests to work web are refused: from its opaque origin they are cross-site", () => {
    const port = 4321;
    // A fetch or form from the sandboxed page: Origin null, cross-site — a read and a write alike.
    expect(
      refuseReason({ method: 'GET', host: `127.0.0.1:${port}`, origin: 'null', secFetchSite: 'cross-site', secFetchMode: 'cors' }, port),
    ).not.toBeNull();
    expect(
      refuseReason({ method: 'POST', host: `127.0.0.1:${port}`, origin: 'null', secFetchSite: 'cross-site', secFetchMode: 'cors' }, port),
    ).not.toBeNull();
    expect(refuseReason({ method: 'POST', host: `127.0.0.1:${port}`, origin: 'null' }, port)).not.toBeNull();
    // The dashboard framing it: same-origin, allowed.
    expect(
      refuseReason(
        { method: 'GET', host: `127.0.0.1:${port}`, secFetchSite: 'same-origin', secFetchMode: 'navigate', secFetchDest: 'iframe' },
        port,
      ),
    ).toBeNull();
  });

  describe('the pane beside the terminal (`work show --diff`, a pane tab)', () => {
    it("opens on the session's Diff, Review or Code; showing a file opens it on the file; close closes it", async () => {
      const a = app();
      const diff = (await (await post(a, { view: 'diff' })).json()) as SessionShownWire;
      expect(diff.pane).toMatchObject({ tab: 'diff' });
      expect(diff.shown).toBeNull();
      expect((await get(a)).pane?.tab).toBe('diff');
      expect(((await (await post(a, { view: 'review' })).json()) as SessionShownWire).pane?.tab).toBe('review');
      const file = (await (await post(a, { file: path.join(wt, 'docs', 'spec.md') })).json()) as SessionShownWire;
      expect(file.pane?.tab).toBe('file');
      // Another view keeps the file, for its tab.
      const code = (await (await post(a, { view: 'code' })).json()) as SessionShownWire;
      expect(code.pane).toMatchObject({ tab: 'code' });
      expect(code.pane?.place).toBeUndefined();
      expect(code.shown?.path).toBe('docs/spec.md');
      expect(events.length).toBe(4);
      expect(await (await post(a, { close: true })).json()).toEqual({ shown: null, pane: null });
    });

    it('the Code view at a place: a file the Code tab lists, its line (`work show --code file:line`)', async () => {
      const a = app();
      const at = (await (await post(a, { view: 'code', file: path.join(wt, 'docs', 'spec.md'), line: 12 })).json()) as SessionShownWire;
      expect(at.pane).toMatchObject({ tab: 'code', place: { repo: 'wt', path: 'docs/spec.md', line: 12 } });
      const noLine = (await (await post(a, { view: 'code', repo: 'wt', path: 'docs/spec.md', line: -3 })).json()) as SessionShownWire;
      expect(noLine.pane?.place).toEqual({ repo: 'wt', path: 'docs/spec.md' });
      // Not one it lists, or outside the session: refused, and the pane stays as it was.
      expect((await post(a, { view: 'code', file: path.join(wt, 'ignored.md') })).status).toBe(404);
      expect((await post(a, { view: 'code', file: path.join(home, 'elsewhere.html') })).status).toBe(404);
      expect((await get(a)).pane?.place).toEqual({ repo: 'wt', path: 'docs/spec.md' });
    });

    it('refuses an unknown view, and the file tab while no file is shown', async () => {
      const a = app();
      expect((await post(a, { view: 'terminal' })).status).toBe(400);
      expect((await post(a, { view: 7 })).status).toBe(400);
      expect((await post(a, { view: 'file' })).status).toBe(409);
      expect((await get(a)).pane).toBeNull();
      expect(events).toEqual([]);
    });
  });
});
