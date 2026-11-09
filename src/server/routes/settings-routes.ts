import type { Context, Hono } from 'hono';
import { SettingsError } from '../../core/settings/settings-schema.js';
import type { SettingsSource } from '../../core/settings/settings-source.js';
import type { RepoSettingsWire, SettingsWire } from '../../core/api-types.js';

/**
 * Work's settings and a repo's (settings-schema.ts says which):
 *
 *   GET /api/settings                         the settings written in config.json
 *   PUT /api/settings                {path, value}   one of them (null: back to its default)
 *   GET /api/repos/:alias/settings            a repo's settings and what is known of it
 *   PUT /api/repos/:alias/settings   {key, value}    one of them (null: taken out)
 *
 * A value that doesn't fit is 400 with why, an unknown setting or repo 404. Every change broadcasts
 * `settings-changed` (a repo's `repos-changed` too).
 */
export function mountSettingsRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void; source: SettingsSource }): void {
  const src = opts.source;
  const refused = (c: Context, err: unknown) => {
    if (err instanceof SettingsError) return c.json({ error: err.message }, err.status);
    throw err;
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

  app.get('/api/settings', (c) => c.json(src.read() satisfies SettingsWire));

  app.put('/api/settings', async (c) => {
    const b = await body(c);
    if (typeof b.path !== 'string' || !('value' in b)) return c.json({ error: 'path and value are required' }, 400);
    try {
      const out = await src.write(b.path, b.value);
      opts.broadcast('settings-changed', { ts: Date.now() });
      return c.json(out satisfies SettingsWire);
    } catch (err) {
      return refused(c, err);
    }
  });

  app.get('/api/repos/:alias/settings', (c) => {
    try {
      return c.json(src.readRepo(c.req.param('alias')) satisfies RepoSettingsWire);
    } catch (err) {
      return refused(c, err);
    }
  });

  app.put('/api/repos/:alias/settings', async (c) => {
    const b = await body(c);
    if (typeof b.key !== 'string' || !('value' in b)) return c.json({ error: 'key and value are required' }, 400);
    try {
      const out = await src.writeRepo(c.req.param('alias'), b.key, b.value);
      opts.broadcast('settings-changed', { ts: Date.now() });
      opts.broadcast('repos-changed', { ts: Date.now() });
      return c.json(out satisfies RepoSettingsWire);
    } catch (err) {
      return refused(c, err);
    }
  });
}
