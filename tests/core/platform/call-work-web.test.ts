import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callWorkWeb } from '../../../src/core/platform/web-discovery.js';

/** callWorkWeb: a CLI command's call to the running work web — the answer, a refusal with its reason, or "none running". */

let home: string;
let server: http.Server | null = null;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'call-web-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  fs.rmSync(home, { recursive: true, force: true });
});

async function serve(handler: http.RequestListener): Promise<void> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  fs.writeFileSync(path.join(home, '.work', 'web.url'), `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`);
}

describe('callWorkWeb', () => {
  it('no work web: status 0 and how to start one', async () => {
    expect(await callWorkWeb('GET', '/api/x')).toMatchObject({ ok: false, status: 0, error: expect.stringContaining('work web') });
  });

  it('sends the method and JSON body; returns the answer, or the refusal’s own reason', async () => {
    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    await serve((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body });
        res.writeHead(req.url === '/api/refuse' ? 409 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url === '/api/refuse' ? { error: 'it is archived: restore it first' } : { how: 'typed' }));
      });
    });
    expect(await callWorkWeb('POST', '/api/send', { text: 'hi' })).toEqual({ ok: true, body: { how: 'typed' } });
    expect(seen[0]).toEqual({ method: 'POST', url: '/api/send', body: '{"text":"hi"}' });
    expect(await callWorkWeb('POST', '/api/refuse', {})).toEqual({ ok: false, status: 409, error: 'it is archived: restore it first' });
  });

  it('a work web that doesn’t answer in time: status 0, not a hang', async () => {
    await serve(() => {}); // never answers
    expect(await callWorkWeb('GET', '/api/x', undefined, 300)).toMatchObject({ ok: false, status: 0, error: expect.stringContaining('did not answer') });
  });
});
