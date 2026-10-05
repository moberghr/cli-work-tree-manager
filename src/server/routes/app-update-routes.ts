import type { Hono } from 'hono';
import { markSeenVersion, requestDesktop, type createUpdates } from '../../core/updates/update-source.js';
import { parseVersion } from '../../core/updates/updates.js';
import type { UpdateWire } from '../../core/api-types.js';

/**
 * Updates and release notes (core/updates/): where an update stands, Check
 * for updates, Restart into a downloaded one (the desktop app), the notes,
 * and "seen" for the notes that open once after an upgrade. GETs only read
 * what was fetched; the fetches are the sweep's (web-server) and the
 * check's (a POST).
 */
export function mountAppUpdateRoutes(
  app: Hono,
  opts: {
    updates: ReturnType<typeof createUpdates>;
    broadcast: (event: string, data: unknown) => void;
    /** The dev server (`work web --dev`): it runs a checkout, not the installed app — it reports no update
     *  and never asks the app for one (its Restart would close the installed app). */
    dev?: boolean;
    /** Test seams. */
    requestDesktop?: typeof requestDesktop;
    markSeen?: typeof markSeenVersion;
  },
): void {
  const { updates } = opts;
  const ask = opts.requestDesktop ?? requestDesktop;
  const seen = opts.markSeen ?? markSeenVersion;

  const wire = (): UpdateWire => (opts.dev ? { ...updates.wire(), desktop: null, available: null } : updates.wire());
  const devRefusal = { error: "The dev server doesn't update: it runs this checkout. The installed app updates itself." };

  app.get('/api/updates', (c) => c.json(wire() satisfies UpdateWire));

  // Check for updates: the release list again, and the desktop app's updater (it answers in its file).
  app.post('/api/updates/check', async (c) => {
    if (opts.dev) return c.json(devRefusal, 409);
    if (updates.wire().desktop) ask('check');
    await updates.refresh();
    opts.broadcast('updates-changed', { ts: Date.now() });
    return c.json(updates.wire() satisfies UpdateWire);
  });

  // Restart into the update the desktop app downloaded. The app exits and comes back on it;
  // work web and the PTY host run from ~/.work/runtime, so sessions stay.
  app.post('/api/updates/restart', (c) => {
    if (opts.dev) return c.json(devRefusal, 409);
    const w = updates.wire();
    if (w.available?.how !== 'restart') return c.json({ error: 'No downloaded update to restart into.' }, 409);
    ask('restart');
    return c.json({ ok: true });
  });

  app.get('/api/updates/notes', (c) => c.json({ releases: updates.notes(), checkError: wire().checkError }));

  app.post('/api/updates/seen', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { version?: unknown } | null;
    if (typeof b?.version !== 'string' || !parseVersion(b.version)) return c.json({ error: 'expected {version}' }, 400);
    seen(b.version);
    opts.broadcast('updates-changed', { ts: Date.now() });
    return c.json({ ok: true });
  });
}
