import type { Context, Hono } from 'hono';
import type { RepoSettingsWire, SettingsWire } from '../../core/api-types.js';
import {
  checkRepoSetting,
  checkSetting,
  settingAt,
  SettingsError,
  type RepoSettingKey,
  type RepoSettingsValues,
} from '../../core/settings/settings-schema.js';
import type { SettingsSource } from '../../core/settings/settings-source.js';

/**
 * The demo's settings: a pretend config.json in memory, changed by the real rules (settings-schema.ts), so the
 * Settings page and a repo's settings work there as in work web, and nothing is written.
 */
export function createDemoSettings(repoPathOf: (alias: string) => string | null): SettingsSource {
  const values: Record<string, unknown> = {
    worktreesRoot: '~/worktrees',
    editor: 'code',
    'prWatch.trustedBots': ['copilot-pull-request-reviewer', 'github-actions'],
    'time.gapTicket': 'OPS-1',
  };
  const repos = new Map<string, RepoSettingsValues>([
    ['api', { requiredChecks: ['build', 'test'], devCommand: 'npm run dev', reviews: 'all' }],
  ]);
  const read = (): SettingsWire => ({ values: { ...values }, configPath: '~/.work/config.json (demo: kept in memory)' });
  const readRepo = (alias: string): RepoSettingsWire => {
    const p = repoPathOf(alias);
    if (!p) throw new SettingsError(`${alias} isn't one of your repos`, 404);
    return {
      alias,
      path: p,
      origin: `https://github.com/acme/${alias}`,
      host: alias === 'payments' ? 'Azure DevOps' : 'GitHub',
      ...(repos.get(alias) ?? { requiredChecks: null, devCommand: null, reviews: null }),
    };
  };
  return {
    read,
    async write(path, value) {
      const f = settingAt(path);
      if (!f) throw new SettingsError(`no setting ${path}`, 404);
      const r = checkSetting(f, value);
      if (!r.ok) throw new SettingsError(`${f.label}: ${r.error}`);
      if (r.value === null) delete values[path];
      else values[path] = r.value;
      return read();
    },
    readRepo,
    async writeRepo(alias, key, value) {
      readRepo(alias); // 404 for one that isn't a repo
      if (!['requiredChecks', 'devCommand', 'reviews'].includes(key)) throw new SettingsError(`no repo setting ${key}`, 404);
      const r = checkRepoSetting(key as RepoSettingKey, value);
      if (!r.ok) throw new SettingsError(r.error);
      const now = repos.get(alias) ?? { requiredChecks: null, devCommand: null, reviews: null };
      repos.set(alias, { ...now, [key]: r.value });
      return readRepo(alias);
    },
  };
}

/** The settings routes, as work web's (routes/settings-routes.ts), over the demo's settings. */
export function mountDemoSettings(app: Hono, broadcast: (event: string, data: unknown) => void, src: SettingsSource): void {
  const refused = (c: Context, err: unknown) => {
    if (err instanceof SettingsError) return c.json({ error: err.message }, err.status);
    throw err;
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  app.get('/api/settings', (c) => c.json(src.read()));
  app.put('/api/settings', async (c) => {
    const b = await body(c);
    if (typeof b.path !== 'string' || !('value' in b)) return c.json({ error: 'path and value are required' }, 400);
    try {
      const out = await src.write(b.path, b.value);
      broadcast('settings-changed', { ts: Date.now() });
      return c.json(out);
    } catch (err) {
      return refused(c, err);
    }
  });
  app.get('/api/repos/:alias/settings', (c) => {
    try {
      return c.json(src.readRepo(c.req.param('alias')));
    } catch (err) {
      return refused(c, err);
    }
  });
  app.put('/api/repos/:alias/settings', async (c) => {
    const b = await body(c);
    if (typeof b.key !== 'string' || !('value' in b)) return c.json({ error: 'key and value are required' }, 400);
    try {
      const out = await src.writeRepo(c.req.param('alias'), b.key, b.value);
      broadcast('settings-changed', { ts: Date.now() });
      broadcast('repos-changed', { ts: Date.now() });
      return c.json(out);
    } catch (err) {
      return refused(c, err);
    }
  });
}
