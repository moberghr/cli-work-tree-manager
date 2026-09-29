import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { devCommandFor, devLogTail, devState, isListening, startDev, stopDev } from '../../src/core/dev-server.js';
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
