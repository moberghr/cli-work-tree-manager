import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { devCommandFor, devLogTail, devState, isListening, startDev, stopDev } from '../../src/core/dev-server.js';
import { bootTime, processName } from '../../src/core/process.js';
import { withDb } from '../../src/core/db.js';
import type { WorktreeSession } from '../../src/core/session-types.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-server-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const session = (over: Partial<WorktreeSession> = {}): WorktreeSession => ({
  target: 'web', branch: 'feat/x', isGroup: false, paths: [home],
  createdAt: '', lastAccessedAt: '', port: undefined, ...over,
});
const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

describe('devCommandFor', () => {
  const config = {
    repos: { web: '/src/web-app', api: '/src/api-svc' },
    groups: { shop: ['api', 'web'] },
    devCommands: { web: 'npm run dev' },
  };
  it('uses the repo alias of a single-repo session', () => {
    expect(devCommandFor(session(), config)).toEqual({ command: 'npm run dev', cwd: home, repo: 'web' });
    expect(devCommandFor(session({ target: 'api' }), config)).toBeNull();
  });
  it('in a group, picks the first repo with a command, matched by folder name', () => {
    const g = session({ target: 'shop', isGroup: true, paths: ['/wt/shop/x/api-svc', '/wt/shop/x/web-app'] });
    expect(devCommandFor(g, config)).toEqual({ command: 'npm run dev', cwd: '/wt/shop/x/web-app', repo: 'web' });
  });
  it('is null without config', () => {
    expect(devCommandFor(session(), null)).toBeNull();
  });
});

describe('isListening', () => {
  it('tells a serving port from a free one', async () => {
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await isListening(port)).toBe(true);
    await new Promise((r) => srv.close(r));
    expect(await isListening(port)).toBe(false);
  });
});

describe('a saved dev-server pid is only trusted while it is still ours', () => {
  // An unrelated long-running process standing in for "whatever got the pid".
  let other: ChildProcess;
  beforeEach(() => {
    other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  });
  afterEach(() => {
    try {
      other.kill();
    } catch {
      /* gone */
    }
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const save = (rec: Record<string, unknown>) =>
    withDb((d) => d.prepare('INSERT OR REPLACE INTO dev_runs (session_id, data) VALUES (?, ?)').run('s1', JSON.stringify(rec)));
  const s = () => session({ port: 3999 });

  it('after a reboot the old row is dropped: not shown as running, Stop kills nothing', async () => {
    // Started an hour before this boot: whatever has that pid now isn't it.
    const beforeBoot = new Date(bootTime() - 60 * 60 * 1000).toISOString();
    save({ pid: other.pid, command: 'npm run dev', cwd: home, startedAt: beforeBoot, image: 'cmd.exe' });
    expect((await devState('s1', s(), null)).running).toBeNull();
    expect(stopDev('s1')).toBe(false);
    expect(alive(other.pid!)).toBe(true);
  });

  it('same boot but the pid is now a different program: Stop forgets it instead of killing', () => {
    save({ pid: other.pid, command: 'npm run dev', cwd: home, startedAt: new Date().toISOString(), image: 'definitely-not-this.exe' });
    expect(stopDev('s1')).toBe(false);
    expect(alive(other.pid!)).toBe(true);
    expect(withDb((d) => d.prepare('SELECT 1 FROM dev_runs').get())).toBeUndefined();
  });

  it('a record imported from the old JSON files (no image) is still running after the upgrade', async () => {
    // Otherwise a vite started before the upgrade shows Stopped, Stop can't
    // reach it, and Start collides on the port.
    save({ pid: other.pid, command: 'npm run dev', cwd: home, startedAt: new Date().toISOString() });
    expect((await devState('s1', s(), null)).running?.pid).toBe(other.pid);
    expect(stopDev('s1')).toBe(true);
    await expect.poll(() => alive(other.pid!), { timeout: 10_000 }).toBe(false);
  });

  it('a start time that cannot be parsed is not trusted', async () => {
    save({ pid: other.pid, command: 'npm run dev', cwd: home, startedAt: 'yesterday-ish' });
    expect((await devState('s1', s(), null)).running).toBeNull();
    expect(alive(other.pid!)).toBe(true);
  });

  it('an unreadable process name (tasklist slow or missing) does not forget a live run', () => {
    save({ pid: other.pid, command: 'npm run dev', cwd: home, startedAt: new Date().toISOString(), image: 'cmd.exe' });
    expect(stopDev('s1', () => null)).toBe(true); // pid alive, this boot: killed
    expect(withDb((d) => d.prepare('SELECT 1 FROM dev_runs').get())).toBeUndefined();
  });

  it('processName reads a live process and returns null for a dead one', () => {
    expect(processName(other.pid!)?.toLowerCase()).toMatch(/^node(\.exe)?$/);
    expect(processName(2 ** 22 + 12345)).toBeNull();
  });
});

describe('startDev / stopDev', () => {
  it('runs the command on $PORT, detached, logged, and stops the whole tree', async () => {
    const port = await freePort();
    const s = session({ port });
    const script = path.join(home, 'serve.cjs');
    fs.writeFileSync(script, "require('http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready on ' + process.env.PORT));\n");
    const config = { repos: {}, groups: {}, devCommands: { web: `node "${script}"` } };

    expect(startDev('s1', session(), config)).toMatchObject({ ok: false, status: 400 }); // no port
    expect(startDev('s1', s, { repos: {}, groups: {} })).toMatchObject({ ok: false, status: 400 }); // no command

    expect(startDev('s1', s, config)).toMatchObject({ ok: true });
    expect(startDev('s1', s, config)).toMatchObject({ ok: false, status: 409 });
    await expect.poll(() => isListening(port), { timeout: 15_000 }).toBe(true);
    const state = await devState('s1', s, config);
    expect(state).toMatchObject({ port, listening: true, url: `http://localhost:${port}/`, repo: 'web' });
    expect(state.running?.pid).toBeGreaterThan(0);
    await expect.poll(() => devLogTail('s1'), { timeout: 5_000 }).toContain(`ready on ${port}`);

    expect(stopDev('s1')).toBe(true);
    await expect.poll(() => isListening(port), { timeout: 15_000 }).toBe(false);
    expect((await devState('s1', s, config)).running).toBeNull();
    expect(stopDev('s1')).toBe(false);
  }, 40_000);
});
