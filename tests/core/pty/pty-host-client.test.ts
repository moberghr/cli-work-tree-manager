import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let configDir: string;
vi.mock('../../../src/core/platform/config.js', () => ({ getConfigDir: () => configDir }));
// The logger finds the folder through config-dir.js (not config.js, which reports through the logger).
vi.mock('../../../src/core/platform/config-dir.js', () => ({ getConfigDir: () => configDir }));

import { findHost, PtyHostVersionError, PtyHostClient } from '../../../src/core/pty/pty-host-client.js';
import { PROTOCOL_VERSION } from '../../../src/core/pty/pty-host-protocol.js';

let server: http.Server | null = null;

/** A stand-in host answering /health with the given protocol version. */
async function fakeHost(version: number, token = 'tok'): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.headers['x-work-token'] !== token) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version, pid: 1 }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}
const writeInfo = (info: object) => fs.writeFileSync(path.join(configDir, 'pty-host.json'), JSON.stringify(info));

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

describe('PtyHostClient.restart', () => {
  /** A host whose restart answers `reply` and records the body it was sent. */
  async function restartHost(status: number, reply: object): Promise<{ client: PtyHostClient; bodies: string[] }> {
    const bodies: string[] = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    return { client: new PtyHostClient({ pid: 1, port, token: 'tok', version: PROTOCOL_VERSION }), bodies };
  }

  it('sends the agent environment, and takes a host that echoed it as restarted', async () => {
    const { client, bodies } = await restartHost(200, { id: 's', agentEnvApplied: true });
    expect(await client.restart('s', { agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } })).toBe('restarted');
    expect(JSON.parse(bodies[0])).toEqual({ agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } });
  });

  it('a host that restarted without taking the environment (one from before) is unsupported: the caller starts it fresh', async () => {
    const { client } = await restartHost(200, { id: 's' });
    expect(await client.restart('s', { agentEnv: { CLAUDE_CONFIG_DIR: null } })).toBe('unsupported');
  });

  it('without an environment it is the plain restart: no body, the host’s answer is enough', async () => {
    const { client, bodies } = await restartHost(200, { id: 's' });
    expect(await client.restart('s')).toBe('restarted');
    expect(bodies[0]).toBe('');
  });
});

describe('PtyHostClient.halt / resume', () => {
  async function host(status: number, reply: object = {}): Promise<{ client: PtyHostClient; seen: string[] }> {
    const seen: string[] = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    return { client: new PtyHostClient({ pid: 1, port, token: 'tok', version: PROTOCOL_VERSION }), seen };
  }
  const closeServer = () => new Promise<void>((r) => server!.close(() => r()));

  it('halt: 200 is halted, 409 not running, 404 (a host from before) unsupported, so the caller stops it the old way', async () => {
    const ok = await host(200);
    expect(await ok.client.halt('s')).toBe('halted');
    expect(ok.seen[0]).toContain('POST /ptys/s/halt');
    await closeServer();
    expect(await (await host(409)).client.halt('s')).toBe('not-running');
    await closeServer();
    expect(await (await host(404, { error: 'not found' })).client.halt('s')).toBe('unsupported');
  });

  it('halt: a refusal with a reason throws it', async () => {
    const { client } = await host(500, { error: 'its agent is already being restarted or halted' });
    await expect(client.halt('s')).rejects.toThrow(/already/);
  });

  it('features: what /health answers, asked once per host; [] for a host from before; null (asked again) when it fails', async () => {
    const ok = await host(200, { version: PROTOCOL_VERSION, pid: 1, features: ['agentEnv', 'halt', 7] });
    expect(await ok.client.features()).toEqual(['agentEnv', 'halt']);
    expect(await ok.client.features()).toEqual(['agentEnv', 'halt']);
    expect(ok.seen.filter((l) => l.startsWith('GET /health'))).toHaveLength(1);
    await closeServer();
    expect(await (await host(200, { version: PROTOCOL_VERSION, pid: 1 })).client.features()).toEqual([]);
    await closeServer();
    const bad = await host(500);
    expect(await bad.client.features()).toBeNull();
    expect(await bad.client.features()).toBeNull();
    expect(bad.seen).toHaveLength(2);
  });

  it('resume sends the environment; 409 is not halted', async () => {
    const ok = await host(200);
    expect(await ok.client.resume('s', { agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } })).toBe('resumed');
    expect(ok.seen[0]).toContain('POST /ptys/s/resume {"agentEnv":{"CLAUDE_CONFIG_DIR":"/acc/work"}}');
    await closeServer();
    expect(await (await host(409)).client.resume('s')).toBe('not-halted');
  });
});
