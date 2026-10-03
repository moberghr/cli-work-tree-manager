import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION } from '../../../src/core/pty/pty-host-protocol.js';

/**
 * Exactly one PTY host may ever start (reviewed bug): two would each
 * restore every saved session — two Claudes per conversation. Spawning is
 * simulated: the mocked child_process.spawn "starts a host" by bringing up
 * a fake /health server and writing the discovery file after a delay.
 */

let configDir: string;
vi.mock('../../../src/core/platform/config.js', () => ({ getConfigDir: () => configDir }));

const servers: http.Server[] = [];
const spawnCalls: string[][] = [];
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args);
    setTimeout(async () => {
      const pid = 1000 + spawnCalls.length;
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: PROTOCOL_VERSION, pid }));
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      fs.writeFileSync(path.join(configDir, 'pty-host.json'), JSON.stringify({ pid, port, token: 't', version: PROTOCOL_VERSION }));
    }, 300);
    return { unref() {} };
  },
}));

async function freshClient() {
  vi.resetModules();
  return import('../../../src/core/pty/pty-host-client.js');
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-single-'));
  spawnCalls.length = 0;
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('ensureHost starts one host, never two', () => {
  it('concurrent callers in one process share a single spawn', async () => {
    const c = await freshClient();
    const [a, b, d] = await Promise.all([c.ensureHost('bin.js'), c.ensureHost('bin.js'), c.ensureHost('bin.js')]);
    expect(spawnCalls).toHaveLength(1);
    expect(a.pid).toBe(b.pid);
    expect(d.pid).toBe(a.pid);
  });

  it('callers from separate module instances (≈ processes) are serialized by the lock', async () => {
    // e.g. after a reboot: resumePersistedSessions() and a browser reopening
    // a Terminal tab race to start the host.
    const one = await freshClient();
    const two = await freshClient();
    expect(one).not.toBe(two);
    const [a, b] = await Promise.all([one.ensureHost('bin.js'), two.ensureHost('bin.js')]);
    expect(spawnCalls).toHaveLength(1);
    expect(a.pid).toBe(b.pid);
  });

  it('a host that is busy (slow to answer) is waited for, never replaced', async () => {
    // A running host whose event loop is blocked (a ConPTY spawn, a big
    // restore) answers nothing for a while, then everything at once. The
    // first probe times out; treating that as "no host" started a second
    // one, which restored every session again.
    const busyUntil = Date.now() + 2500; // longer than two short probes
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: PROTOCOL_VERSION, pid: process.pid }));
      }, Math.max(0, busyUntil - Date.now()));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(configDir, 'pty-host.json'), JSON.stringify({ pid: process.pid, port, token: 't', version: PROTOCOL_VERSION }));

    const c = await freshClient();
    const host = await c.ensureHost('bin.js');
    expect(host.pid).toBe(process.pid);
    expect(spawnCalls).toHaveLength(0);
  }, 20_000);

  it('findHost reports a host that never answers as busy, not gone', async () => {
    const server = http.createServer(() => {
      /* never answers */
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(configDir, 'pty-host.json'), JSON.stringify({ pid: process.pid, port, token: 't', version: PROTOCOL_VERSION }));
    const c = await freshClient();
    await expect(c.findHost([50, 100])).rejects.toBeInstanceOf(c.PtyHostBusyError);
    server.closeAllConnections();
  });

  it('a stale file whose host is dead — someone else on the port, not answering — is "no host", so one can start', async () => {
    const server = http.createServer(() => {
      /* never answers */
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const deadPid = 2 ** 22 + 12345;
    fs.writeFileSync(path.join(configDir, 'pty-host.json'), JSON.stringify({ pid: deadPid, port, token: 't', version: PROTOCOL_VERSION }));
    const c = await freshClient();
    expect(await c.findHost([50, 100])).toBeNull();
    server.closeAllConnections();
  });

  it('an already-running host is reused without spawning', async () => {
    const c = await freshClient();
    await c.ensureHost('bin.js');
    const again = await freshClient();
    await again.ensureHost('bin.js');
    expect(spawnCalls).toHaveLength(1);
  });
});
