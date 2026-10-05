import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import http from 'node:http';
import { refuseReason } from '../../src/server/local-origin.js';
import { launch } from '../../src/server/diff-server.js';
import { attachTerminalWs } from '../../src/server/terminal-ws.js';

const P = 4321;
const H = `127.0.0.1:${P}`;

describe('refuseReason', () => {
  it('accepts our own browser page, non-browser callers, and safe reads', () => {
    expect(refuseReason({ method: 'POST', host: H, origin: `http://${H}`, secFetchSite: 'same-origin' }, P)).toBeNull();
    expect(refuseReason({ method: 'POST', host: `localhost:${P}`, origin: `http://localhost:${P}` }, P)).toBeNull();
    expect(refuseReason({ method: 'POST', host: H }, P)).toBeNull(); // hooks / wd / CLI send no Origin
    expect(refuseReason({ method: 'GET', host: H, origin: 'https://evil.example' }, P)).toBeNull(); // unreadable cross-origin
  });

  it('refuses cross-site writes, foreign WebSockets, null origins and foreign hosts', () => {
    expect(refuseReason({ method: 'POST', host: H, origin: 'https://evil.example' }, P)).toBe('foreign origin');
    expect(refuseReason({ method: 'DELETE', host: H, origin: 'http://127.0.0.1:9999' }, P)).toBe('foreign origin');
    expect(refuseReason({ method: 'GET', upgrade: true, host: H, origin: 'https://evil.example' }, P)).toBe('foreign origin');
    expect(refuseReason({ method: 'POST', host: H, origin: 'null' }, P)).toBe('foreign origin');
    expect(refuseReason({ method: 'GET', host: H, secFetchSite: 'cross-site' }, P)).toBe('cross-site request');
    expect(refuseReason({ method: 'GET', host: 'evil.example' }, P)).toBe('bad host');
  });

  it('treats another localhost port (same-site: a dev server) like another site', () => {
    expect(refuseReason({ method: 'GET', host: H, secFetchSite: 'same-site', secFetchMode: 'no-cors', secFetchDest: 'image' }, P)).toBe(
      'cross-site request',
    );
    expect(
      refuseReason({ method: 'GET', host: H, secFetchSite: 'same-site', secFetchMode: 'navigate', secFetchDest: 'document' }, P),
    ).toBeNull();
    expect(refuseReason({ method: 'GET', host: H, secFetchSite: 'same-origin' }, P)).toBeNull();
  });

  it('opens a dashboard link clicked on another site (a top-level page load)', () => {
    const nav = { host: H, secFetchSite: 'cross-site', secFetchMode: 'navigate', secFetchDest: 'document' };
    expect(refuseReason({ method: 'GET', ...nav }, P)).toBeNull();
    expect(refuseReason({ method: 'HEAD', ...nav }, P)).toBeNull();
    // …but not a form POST navigation, a frame, or a script/fetch load.
    expect(refuseReason({ method: 'POST', ...nav }, P)).toBe('cross-site request');
    expect(refuseReason({ method: 'GET', ...nav, secFetchDest: 'iframe' }, P)).toBe('cross-site request');
    expect(refuseReason({ method: 'GET', ...nav, secFetchMode: 'cors', secFetchDest: 'empty' }, P)).toBe('cross-site request');
    expect(refuseReason({ method: 'GET', upgrade: true, ...nav, origin: 'https://evil.example' }, P)).toBe('cross-site request');
  });
});

describe('the launch() guard on a real server', () => {
  it('a page on another site cannot POST (even text/plain, the no-preflight trick)', async () => {
    const app = new Hono();
    let hits = 0;
    app.post('/api/x', (c) => {
      hits++;
      return c.json({ ok: true });
    });
    const h = await launch(app);
    const url = `http://127.0.0.1:${h.port}/api/x`;
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: '{}' });

    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(hits).toBe(0);
    expect((await post({ origin: `http://127.0.0.1:${h.port}` })).status).toBe(200);
    expect((await post({})).status).toBe(200); // Node caller, no Origin
    expect(hits).toBe(2);
    await h.stop();
  });

  it('a link to the dashboard clicked on another site loads the page', async () => {
    const app = new Hono();
    app.get('/diff/abc', (c) => c.html('<p>diff</p>'));
    const h = await launch(app);
    // Raw http.request: Node's fetch forces its own Sec-Fetch-Mode, while a
    // browser navigation sends exactly these.
    const get = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: h.port, path: '/diff/abc', headers }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
      });
    const nav = await get({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    expect(nav.status).toBe(200);
    expect(nav.body).toContain('diff');
    // The same page pulled into a frame on that site is still refused.
    expect((await get({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })).status).toBe(403);
    await h.stop();
  });
});

describe('the terminal WebSocket', () => {
  it('refuses a connection from another origin before it reaches any session', async () => {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const bridge = attachTerminalWs(server, port);
    const url = `ws://127.0.0.1:${port}/ws/sessions/abc/terminal`;
    const outcome = (origin?: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(url, origin ? { origin } : {});
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
        ws.on('error', () => resolve('refused'));
      });
    expect(await outcome('https://evil.example')).toBe('refused');
    expect(await outcome(`http://127.0.0.1:${port}`)).toBe('open');
    bridge.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
