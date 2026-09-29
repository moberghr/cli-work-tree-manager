import http from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * The browser ↔ PTY-host relay. Reviewed bug: if the browser left while
 * ensurePty() was still starting the host, the upstream opened afterwards
 * was never closed — a leaked host connection with a live subscriber.
 */

let hostUrl = '';
let ensureDelay = 0;
let spawns = 0;
vi.mock('../../src/core/pty-pool.js', () => ({
  ensurePty: async () => {
    spawns++;
    await new Promise((r) => setTimeout(r, ensureDelay));
    return hostUrl;
  },
  peekPty: () => false,
}));

import { attachTerminalWs, claudeElsewhere, ELSEWHERE_ACTIVE_MS, ELSEWHERE_IDLE_MS } from '../../src/core/terminal-ws.js';
import type { TerminalElsewhere } from '../../src/core/api-types.js';
let elsewhere: TerminalElsewhere | null = null;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A stand-in PTY host that counts connections and echoes input. */
async function fakeHost() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const conns: WebSocket[] = [];
  wss.on('connection', (ws) => {
    conns.push(ws);
    ws.send(JSON.stringify({ type: 'replay', data: '', cols: 80, rows: 24 }));
    ws.on('message', (m) => ws.send(Buffer.from('echo:' + m.toString()), { binary: true }));
  });
  cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
  hostUrl = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/ptys/s/attach`;
  return { conns, open: () => conns.filter((c) => c.readyState === WebSocket.OPEN).length };
}

async function relay() {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const bridge = attachTerminalWs(server, port, { elsewhere: () => elsewhere });
  cleanups.push(() => {
    bridge.close();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return `ws://127.0.0.1:${port}/ws/sessions/s/terminal`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('claudeElsewhere — is its Claude running outside the host?', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const idle = (agoMs: number) => ({ state: 'idle' as const, updatedAt: new Date(now - agoMs).toISOString() });

  it('a fresh transcript write, a working or blocked status, or a recent Stop means yes', () => {
    expect(claudeElsewhere({ hasPty: false, lastActivityMs: now - 40_000, status: null }, now)).toMatchObject({ type: 'elsewhere', lastActivity: now - 40_000 });
    expect(claudeElsewhere({ hasPty: false, lastActivityMs: null, status: { state: 'working', updatedAt: idle(0).updatedAt } }, now)).not.toBeNull();
    // Blocked on a permission prompt: silent for hours, still there.
    expect(claudeElsewhere({ hasPty: false, lastActivityMs: now - 5 * 3_600_000, status: { state: 'needs_input', updatedAt: idle(5 * 3_600_000).updatedAt } }, now)?.state).toBe('needs_input');
    expect(claudeElsewhere({ hasPty: false, lastActivityMs: now - 20 * 60_000, status: idle(20 * 60_000) }, now)).not.toBeNull();
  });

  it('quiet long enough is unknown, so the tab may spawn; a host PTY never counts as elsewhere', () => {
    expect(claudeElsewhere({ hasPty: false, lastActivityMs: now - ELSEWHERE_ACTIVE_MS - 1, status: null }, now)).toBeNull();
    expect(claudeElsewhere({ hasPty: false, lastActivityMs: now - 2 * 3_600_000, status: idle(ELSEWHERE_IDLE_MS + 1) }, now)).toBeNull();
    expect(claudeElsewhere({ hasPty: true, lastActivityMs: now, status: { state: 'working', updatedAt: idle(0).updatedAt } }, now)).toBeNull();
  });
});

describe('terminal relay', () => {
  it('when the Claude runs elsewhere: sends the frame, spawns nothing; ?force=1 spawns', async () => {
    await fakeHost();
    ensureDelay = 0;
    spawns = 0;
    elsewhere = { type: 'elsewhere', lastActivity: Date.now() - 10_000, state: 'working' };
    try {
      const url = await relay();
      const browser = new WebSocket(url);
      const frames: string[] = [];
      browser.on('message', (d, bin) => { if (!bin) frames.push(d.toString()); });
      const closed = new Promise<number>((r) => browser.on('close', (code) => r(code)));
      expect(await closed).toBe(1000);
      expect(frames.map((f) => JSON.parse(f))).toEqual([elsewhere]);
      expect(spawns).toBe(0);

      const forced = new WebSocket(url + '?force=1');
      await new Promise((r) => forced.on('open', r));
      await sleep(150);
      expect(spawns).toBe(1);
      forced.close();
      await sleep(100);
    } finally {
      elsewhere = null;
    }
  });

  it('relays both ways and closes the upstream when the browser leaves', async () => {
    const host = await fakeHost();
    ensureDelay = 0;
    const browser = new WebSocket(await relay());
    const got: string[] = [];
    browser.on('message', (d, bin) => { if (bin) got.push(d.toString()); });
    await new Promise((r) => browser.on('open', r));
    await sleep(100);
    browser.send(JSON.stringify({ type: 'input', data: 'hi' }));
    await sleep(150);
    expect(got.join('')).toContain('echo:');
    expect(host.open()).toBe(1);
    browser.close();
    await sleep(150);
    expect(host.open()).toBe(0);
  });

  it('a browser that leaves while the host is still starting never gets an upstream', async () => {
    const host = await fakeHost();
    ensureDelay = 300;
    const browser = new WebSocket(await relay());
    await new Promise((r) => browser.on('open', r));
    browser.close(); // user switched sessions before the host was ready
    await sleep(600);
    expect(host.conns).toHaveLength(0);
  });
});
