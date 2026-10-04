import type { Context, Hono } from 'hono';
import crossSpawn from 'cross-spawn';
import { loadConfig } from '../../core/platform/config.js';
import type { ActivityLog } from '../../core/platform/activity.js';
import { loadHistory } from '../../core/sessions/history.js';
import {
  deleteGroup,
  enrollRepo,
  removeRepo,
  RepoAdminError,
  repoInventory,
  saveGroup,
  setRepoIgnored,
  setScanRoot,
} from '../../core/worktree/repo-admin.js';
import type { ReposWire } from '../../core/api-types.js';

export interface RepoRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  activity?: ActivityLog;
  /** The `work` binary: a group's combined instructions are written by `work config group regen <name>` in a child. */
  workBin?: () => string;
}

/**
 * The Repos page (repo-admin.ts):
 *
 *   GET    /api/repos                     every repo in the scanned folders, the groups (a read: directory listings)
 *   POST   /api/repos                     {alias, path}      enrol it
 *   DELETE /api/repos/:alias[?force=1]    stop knowing it (409 with its live sessions unless forced)
 *   POST   /api/repos/ignore              {path, ignored}
 *   POST   /api/repos/roots               {path, on}         a folder to scan, or not
 *   POST   /api/groups                    {name, members, creating}
 *   DELETE /api/groups/:name[?force=1]
 *
 * Every change broadcasts `repos-changed`. A group made or changed gets its
 * combined instructions file written afterwards, out of process: that is an
 * agent run, which would otherwise hold up every request for a minute.
 */
export function mountRepoRoutes(app: Hono, opts: RepoRoutesOptions): void {
  const config = () => {
    const c = loadConfig();
    if (!c) throw new RepoAdminError('No configuration yet: run `work init` first.');
    return c;
  };
  const answer = async (c: Context, fn: () => Promise<void>) => {
    try {
      await fn();
      opts.broadcast('repos-changed', { ts: Date.now() });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof RepoAdminError) return c.json({ error: err.message, sessions: err.sessions }, err.sessions.length ? 409 : 400);
      throw err;
    }
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const regenerate = (name: string) => {
    const bin = opts.workBin?.();
    if (!bin) return;
    const run = opts.activity?.start('groups', `Writing ${name}'s combined instructions`);
    const child = crossSpawn(
      process.execPath,
      [...process.execArgv.filter((f) => !/^--inspect/.test(f)), bin, 'config', 'group', 'regen', name],
      {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, NO_COLOR: '1' },
      },
    );
    child.on('error', (e) => run?.fail(e.message));
    child.on('close', (code) => (code === 0 ? run?.done('written') : run?.fail(`work config group regen exited ${code}`)));
  };

  app.get('/api/repos', (c) => {
    try {
      return c.json(repoInventory(config(), loadHistory()) satisfies ReposWire);
    } catch (err) {
      if (err instanceof RepoAdminError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.post('/api/repos', async (c) => {
    const b = await body(c);
    if (typeof b.alias !== 'string' || typeof b.path !== 'string') return c.json({ error: 'expected {alias, path}' }, 400);
    return answer(c, () => enrollRepo(b.alias as string, b.path as string));
  });
  app.delete('/api/repos/:alias', (c) =>
    answer(c, () => removeRepo(c.req.param('alias'), loadHistory(), { force: c.req.query('force') === '1' })),
  );
  app.post('/api/repos/ignore', async (c) => {
    const b = await body(c);
    if (typeof b.path !== 'string' || typeof b.ignored !== 'boolean') return c.json({ error: 'expected {path, ignored}' }, 400);
    return answer(c, () => setRepoIgnored(b.path as string, b.ignored as boolean));
  });
  app.post('/api/repos/roots', async (c) => {
    const b = await body(c);
    if (typeof b.path !== 'string' || typeof b.on !== 'boolean') return c.json({ error: 'expected {path, on}' }, 400);
    return answer(c, async () => setScanRoot(b.path as string, b.on as boolean, config()));
  });
  app.post('/api/groups', async (c) => {
    const b = await body(c);
    const members = Array.isArray(b.members) ? b.members.filter((m): m is string => typeof m === 'string') : null;
    if (typeof b.name !== 'string' || !members) return c.json({ error: 'expected {name, members, creating}' }, 400);
    const name = b.name;
    return answer(c, async () => {
      await saveGroup(name, members, { creating: b.creating === true });
      regenerate(name);
    });
  });
  app.delete('/api/groups/:name', (c) =>
    answer(c, () => deleteGroup(c.req.param('name'), loadHistory(), { force: c.req.query('force') === '1' })),
  );
}
