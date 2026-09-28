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
vi.mock('../../src/core/pty-pool.js', () => ({
  ensurePty: async () => {
    await new Promise((r) => setTimeout(r, ensureDelay));
    return hostUrl;
  },
}));

import { attachTerminalWs } from '../../src/core/terminal-ws.js';

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
  const bridge = attachTerminalWs(server, port);
  cleanups.push(() => {
    bridge.close();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return `ws://127.0.0.1:${port}/ws/sessions/s/terminal`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('terminal relay', () => {
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
