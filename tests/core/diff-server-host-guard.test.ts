/**
 * Smoke test for the DNS-rebinding Host-header guard in
 * `diff-server.launch`. Asserts:
 *   - 127.0.0.1:<port> Host → 200 (accepted)
 *   - localhost:<port> Host → 200 (accepted)
 *   - foreign Host (evil.com) → 403 (rejected)
 *   - mismatched-port Host → 403 (rejected)
 *
 * Uses the raw `http` module rather than fetch because undici (Node's
 * fetch) treats Host as a forbidden header and silently rewrites it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { Hono } from 'hono';
import { launch } from '../../src/core/diff-server.js';

const servers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (s) {
      try {
        await s.stop();
      } catch {
        /* */
      }
    }
  }
});

async function startProbeServer(): Promise<{
  url: string;
  port: number;
  stop: () => Promise<void>;
}> {
  const app = new Hono();
  app.get('/ok', (c) => c.text('ok'));
  const handle = await launch(app);
  servers.push(handle);
  return handle;
}

function request(
  port: number,
  hostHeader: string | null,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (hostHeader !== null) headers.Host = hostHeader;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: '/ok',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('diff-server Host guard', () => {
  it('accepts requests with Host = 127.0.0.1:<port>', async () => {
    const { port } = await startProbeServer();
    const res = await request(port, `127.0.0.1:${port}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('accepts requests with Host = localhost:<port>', async () => {
    const { port } = await startProbeServer();
    const res = await request(port, `localhost:${port}`);
    expect(res.status).toBe(200);
  });

  it('rejects requests with a foreign Host header (DNS-rebinding defense)', async () => {
    const { port } = await startProbeServer();
    const res = await request(port, 'evil.com');
    expect(res.status).toBe(403);
  });

  it('rejects requests where Host points at a different port', async () => {
    const { port } = await startProbeServer();
    const res = await request(port, '127.0.0.1:1');
    expect(res.status).toBe(403);
  });
});
