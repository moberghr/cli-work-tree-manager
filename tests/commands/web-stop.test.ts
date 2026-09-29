import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stopExisting } from '../../src/commands/web.js';

/**
 * `work web --stop` must only kill a server that proves it is work web with
 * the recorded pid (reviewed: it killed whatever PID web.pid named — after a
 * reboot that can be any process).
 */
let home: string;
let server: http.Server | null = null;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'web-stop-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  fs.rmSync(home, { recursive: true, force: true });
});

async function fakeWeb(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
function record(url: string, pid: number) {
  fs.writeFileSync(path.join(home, '.work', 'web.url'), url);
  fs.writeFileSync(path.join(home, '.work', 'web.pid'), String(pid));
}
const files = () => ['web.url', 'web.pid'].filter((f) => fs.existsSync(path.join(home, '.work', f)));
const context =
  (pid: number): http.RequestListener =>
  (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: 'dashboard', pid }));
  };

describe('work web --stop', () => {
  it('stops the server that answers with the recorded pid', async () => {
    const kill = vi.fn();
    record(await fakeWeb(context(process.pid)), process.pid);
    expect(await stopExisting(kill, 300)).toBe('stopped');
    expect(kill).toHaveBeenCalledWith(process.pid);
    expect(files()).toEqual([]);
  });

  it('a live PID whose URL answers with ANOTHER pid (reused PID) is not killed', async () => {
    const kill = vi.fn();
    record(await fakeWeb(context(1)), process.pid);
    expect(await stopExisting(kill)).toBe('stale');
    expect(kill).not.toHaveBeenCalled();
    expect(files()).toEqual([]);
  });

  it('nothing listening at the recorded URL → stale, nothing killed', async () => {
    const kill = vi.fn();
    const url = await fakeWeb(context(process.pid));
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    record(url, process.pid);
    expect(await stopExisting(kill)).toBe('stale');
    expect(kill).not.toHaveBeenCalled();
  });

  it('no discovery files → not running', async () => {
    expect(await stopExisting(vi.fn())).toBe('not-running');
  });
});
