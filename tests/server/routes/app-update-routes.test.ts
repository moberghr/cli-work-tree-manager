import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { mountAppUpdateRoutes } from '../../../src/server/routes/app-update-routes.js';
import { createUpdates, type UpdatesDeps } from '../../../src/core/updates/update-source.js';
import type { DesktopUpdate } from '../../../src/core/updates/updates.js';
import type { UpdateWire } from '../../../src/core/api-types.js';

function setup(desktop: DesktopUpdate | null) {
  const deps: UpdatesDeps = {
    fetchReleases: vi.fn(async () => [{ version: '2.1.0', name: 'work 2.1.0', body: 'b', publishedAt: '', url: '' }]),
    running: '2.0.0',
    install: () => (desktop ? 'desktop' : 'npm'),
    desktop: () => desktop,
    seen: () => '2.0.0',
    usedBefore: () => true,
    now: () => 0,
  };
  const updates = createUpdates(deps);
  const requestDesktop = vi.fn();
  const markSeen = vi.fn();
  const events: string[] = [];
  const app = new Hono();
  mountAppUpdateRoutes(app, { updates, broadcast: (e) => void events.push(e), requestDesktop, markSeen });
  const post = (url: string, body: unknown = {}) =>
    app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { app, post, deps, requestDesktop, markSeen, events };
}

describe('the update routes', () => {
  it('GET reads what is known; Check asks GitHub (and the desktop app, when it runs) and tells every window', async () => {
    const t = setup({ appVersion: '2.0.0', state: 'current' });
    expect(((await (await t.app.request('/api/updates')).json()) as UpdateWire).latest).toBeNull();
    expect(t.deps.fetchReleases).not.toHaveBeenCalled();
    const w = (await (await t.post('/api/updates/check')).json()) as UpdateWire;
    expect(w.latest).toBe('2.1.0');
    expect(t.requestDesktop).toHaveBeenCalledWith('check');
    expect(t.events).toEqual(['updates-changed']);
    const notes = (await (await t.app.request('/api/updates/notes')).json()) as { releases: unknown[] };
    expect(notes.releases).toHaveLength(1);
  });

  it('Restart only with a downloaded update: then it asks the desktop app', async () => {
    const none = setup(null);
    expect((await none.post('/api/updates/restart')).status).toBe(409);
    expect(none.requestDesktop).not.toHaveBeenCalled();
    const ready = setup({ appVersion: '2.0.0', state: 'ready', target: '2.1.0' });
    expect((await ready.post('/api/updates/restart')).status).toBe(200);
    expect(ready.requestDesktop).toHaveBeenCalledWith('restart');
  });

  it('seen takes a version and nothing else', async () => {
    const t = setup(null);
    expect((await t.post('/api/updates/seen', { version: '2.1.0' })).status).toBe(200);
    expect(t.markSeen).toHaveBeenCalledWith('2.1.0');
    expect((await t.post('/api/updates/seen', { version: '../../etc' })).status).toBe(400);
  });
});
