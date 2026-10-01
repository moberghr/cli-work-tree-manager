import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * The work web singleton's lifecycle through the BUILT binary, under a
 * throwaway HOME:
 *   - `work web` after a `wd`-autostarted lean instance replaces it with the
 *     full server (it used to reuse it: no Claude hooks, inbox or restore);
 *   - `work web --stop` runs the server's own shutdown — on Windows a kill
 *     is TerminateProcess, which skipped removing its Claude hooks.
 */

const BIN = path.resolve(__dirname, '../../dist/bin.js');
const hasBuild = fs.existsSync(BIN);

let home: string;
let env: NodeJS.ProcessEnv;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'web-life-'));
  env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  fs.writeFileSync(path.join(home, '.work', 'config.json'), JSON.stringify({ worktreesRoot: path.join(home, 'wt'), repos: {}, groups: {}, copyFiles: [] }));
});
afterEach(async () => {
  spawnSync(process.execPath, [BIN, 'web', '--stop'], { env, timeout: 20_000 });
  for (const c of children.splice(0)) {
    try {
      if (c.pid) process.kill(c.pid);
    } catch {
      /* gone */
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const read = (f: string) => {
  try {
    return fs.readFileSync(path.join(home, '.work', f), 'utf-8').trim();
  } catch {
    return null;
  }
};
async function until<T>(get: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
function startWeb(args: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const c = spawn(process.execPath, [BIN, 'web', '--no-open', ...args], { env: { ...env, ...extraEnv }, stdio: 'ignore' });
  children.push(c);
  return c;
}
const context = async () => {
  const url = read('web.url');
  if (!url) return null;
  return fetch(`${url}api/context`).then((r) => r.json() as Promise<{ pid: number; lean: boolean; build?: string }>).catch(() => null);
};
const workHooks = () => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'));
    return JSON.stringify(s.hooks ?? {}).match(/_workHookOwner/g)?.length ?? 0;
  } catch {
    return 0;
  }
};

describe.skipIf(!hasBuild)('work web lifecycle (built binary)', () => {
  it('replaces a lean instance with the full server, and --stop runs its shutdown', async () => {
    startWeb(['--lean']); // what `wd` autostarts
    const lean = await until(context, (c) => !!c?.lean, 'the lean server');

    const full = startWeb([]);
    const ctx = await until(context, (c) => !!c && c.lean === false, 'the full server');
    expect(ctx.pid).not.toBe(lean.pid);
    expect(ctx.pid).toBe(full.pid);
    // The full set (one hook per turn edge + Notification), lean's checkpoint hooks replaced.
    await until(workHooks, (n) => n === 3, "the full server's Claude hooks in settings.json");
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8')).toContain('work hook turn-end');

    const stop = spawnSync(process.execPath, [BIN, 'web', '--stop'], { env, encoding: 'utf-8', timeout: 30_000 });
    expect(stop.status).toBe(0);
    // Its own shutdown ran (not just a kill): the hooks are gone again.
    expect(workHooks()).toBe(0);
    expect(read('web.url')).toBeNull();
  }, 90_000);

  it('replaces a server from an older build (or one too old to say) with this one', async () => {
    // The stale dashboard: started at login weeks ago, before a rebuild.
    startWeb([], { WORK_BUILD_STAMP: 'september' });
    const old = await until(context, (c) => c?.build === 'september', 'the old-build server');

    const fresh = startWeb([]);
    const ctx = await until(context, (c) => !!c && c.pid === fresh.pid, 'the new server');
    expect(ctx.build).not.toBe('september');
    await until(() => { try { process.kill(old.pid, 0); return false; } catch { return true; } }, (gone) => gone, 'the old server to exit');

    // Same build again: reused, not replaced (the singleton rule still holds).
    const again = spawnSync(process.execPath, [BIN, 'web', '--no-open'], { env, encoding: 'utf-8', timeout: 30_000 });
    expect(again.stderr + again.stdout).toMatch(/already running/);
    expect((await context())?.pid).toBe(fresh.pid);
  }, 90_000);
});
