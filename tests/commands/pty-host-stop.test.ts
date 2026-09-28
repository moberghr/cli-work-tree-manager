import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let configDir: string;
vi.mock('../../src/core/config.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/config.js')>()),
  getConfigDir: () => configDir,
}));

import { stopHost } from '../../src/commands/pty-host.js';
import { PROTOCOL_VERSION } from '../../src/core/pty-host-protocol.js';

let server: http.Server | null = null;
async function fakeHost(reportPid: number, token = 'tok'): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.headers['x-work-token'] !== token) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: PROTOCOL_VERSION, pid: reportPid }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}
const infoFile = () => path.join(configDir, 'pty-host.json');
const writeInfo = (pid: number, port: number, token = 'tok') =>
  fs.writeFileSync(infoFile(), JSON.stringify({ pid, port, token, version: PROTOCOL_VERSION }));

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-stop-'));
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('work pty-host --stop only kills a verified host (reviewed bug)', () => {
  it('kills the host that answers with the recorded pid, and removes the file', async () => {
    const kill = vi.fn(() => true);
    writeInfo(4242, await fakeHost(4242));
    expect(await stopHost(kill)).toBe('stopped');
    expect(kill).toHaveBeenCalledWith(4242);
    expect(fs.existsSync(infoFile())).toBe(false);
  });

  it('a stale file (nothing listening — e.g. after a reboot, pid reused) kills NOTHING', async () => {
    const kill = vi.fn(() => true);
    const port = await fakeHost(1);
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    writeInfo(4242, port);
    expect(await stopHost(kill)).toBe('stale-file');
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(infoFile())).toBe(false);
  });

  it('a listener that is not our host (wrong token) or reports another pid kills nothing', async () => {
    const kill = vi.fn(() => true);
    writeInfo(4242, await fakeHost(4242, 'someone-else'));
    expect(await stopHost(kill)).toBe('stale-file');
    await new Promise<void>((r) => server!.close(() => r()));
    writeInfo(4242, await fakeHost(9999));
    expect(await stopHost(kill)).toBe('stale-file');
    expect(kill).not.toHaveBeenCalled();
  });

  it('no discovery file → not running', async () => {
    expect(await stopHost(vi.fn())).toBe('not-running');
  });
});
