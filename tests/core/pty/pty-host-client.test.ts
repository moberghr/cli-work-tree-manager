import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let configDir: string;
vi.mock('../../../src/core/platform/config.js', () => ({ getConfigDir: () => configDir }));

import { findHost, PtyHostVersionError, PtyHostClient } from '../../../src/core/pty/pty-host-client.js';
import { PROTOCOL_VERSION } from '../../../src/core/pty/pty-host-protocol.js';

let server: http.Server | null = null;

/** A stand-in host answering /health with the given protocol version. */
async function fakeHost(version: number, token = 'tok'): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.headers['x-work-token'] !== token) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version, pid: 1 }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}
const writeInfo = (info: object) =>
  fs.writeFileSync(path.join(configDir, 'pty-host.json'), JSON.stringify(info));

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-client-'));
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('findHost', () => {
  it('is null without a discovery file, or with a corrupt one', async () => {
    expect(await findHost()).toBeNull();
    fs.writeFileSync(path.join(configDir, 'pty-host.json'), '{not json');
    expect(await findHost()).toBeNull();
  });

  it('is null when the discovery file is stale (nothing listening)', async () => {
    const port = await fakeHost(PROTOCOL_VERSION);
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    writeInfo({ pid: 1, port, token: 'tok', version: PROTOCOL_VERSION });
    expect(await findHost()).toBeNull();
  });

  it('is null when the token is wrong (another process owns the port)', async () => {
    const port = await fakeHost(PROTOCOL_VERSION, 'other');
    writeInfo({ pid: 1, port, token: 'tok', version: PROTOCOL_VERSION });
    expect(await findHost()).toBeNull();
  });

  it('returns the live host', async () => {
    const port = await fakeHost(PROTOCOL_VERSION);
    writeInfo({ pid: 1, port, token: 'tok', version: PROTOCOL_VERSION });
    expect(await findHost()).toMatchObject({ port, token: 'tok' });
  });

  it('refuses a host from an older build and says how to fix it', async () => {
    const port = await fakeHost(PROTOCOL_VERSION - 1);
    writeInfo({ pid: 1, port, token: 'tok', version: PROTOCOL_VERSION - 1 });
    const err = await findHost().catch((e) => e);
    expect(err).toBeInstanceOf(PtyHostVersionError);
    expect(String(err.message)).toContain('work pty-host --restart');
  });
});

describe('PtyHostClient', () => {
  it('puts the token on the attach URL and encodes the session id', () => {
    const c = new PtyHostClient({ pid: 1, port: 5, token: 'abc', version: PROTOCOL_VERSION });
    expect(c.attachUrl('a/b')).toBe('ws://127.0.0.1:5/ptys/a%2Fb/attach?token=abc');
  });
});
