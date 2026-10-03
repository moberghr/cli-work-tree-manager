import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { atomicWriteFile } from '../platform/fs-safe.js';
import { PtyRegistry } from './pty-registry.js';
import { adoptLegacyRestoreList } from './pty-sessions-file.js';
import { bestEffort } from '../platform/best-effort.js';
import {
  PROTOCOL_VERSION,
  hostInfoPath,
  type ClientFrame,
  type HostInfo,
  type SpawnSpec,
} from './pty-host-protocol.js';
import { report } from '../platform/report.js';

const ATTACH_PATH = /^\/ptys\/([^/?]+)\/attach(?:\?|$)/;
const PTY_PATH = /^\/ptys\/([^/?]+)(\/write|\/screen)?$/;
const MAX_BODY = 1024 * 1024;

export interface PtyHostHandle {
  info: HostInfo;
  registry: PtyRegistry;
  /** Kill every PTY (state file kept for the next restore) and stop. */
  stop(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isSpawnSpec(v: unknown): v is SpawnSpec {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<SpawnSpec>;
  return (
    typeof s.cwd === 'string' &&
    s.cwd.length > 0 &&
    !!s.tool &&
    typeof s.tool.cmd === 'string' &&
    Array.isArray(s.tool.baseArgs)
  );
}

/**
 * The PTY host: a small localhost-only server that owns every Claude PTY
 * so they survive `work web` restarts and rebuilds, and so any number of
 * clients (browser terminal via `work web`, a real terminal via
 * `work attach`) can attach to the same session.
 *
 * Auth: a random token written to `~/.work/pty-host.json` (user-only
 * readable location) must accompany every request — `x-work-token` header
 * for HTTP, `?token=` for the WebSocket upgrade. Plus a Host-header check
 * against DNS rebinding, same as the other local servers (§1.3).
 */
export async function startPtyHost(
  opts: { registry?: PtyRegistry; restore?: boolean; writeInfo?: boolean } = {},
): Promise<PtyHostHandle> {
  const registry = opts.registry ?? new PtyRegistry();
  const token = crypto.randomBytes(24).toString('hex');
  let allowedHosts = new Set<string>();

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (!req.headers.host || !allowedHosts.has(req.headers.host)) return false;
    const given =
      (req.headers['x-work-token'] as string | undefined) ??
      url.searchParams.get('token') ??
      '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!authorized(req, url)) return send(res, 403, { error: 'forbidden' });

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { version: PROTOCOL_VERSION, pid: process.pid });
      }
      if (req.method === 'GET' && url.pathname === '/ptys') {
        return send(res, 200, registry.list());
      }
      const m = url.pathname.match(PTY_PATH);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (m[2] === '/screen' && req.method === 'GET') {
          const text = registry.screen(id);
          return text === null ? send(res, 404, { error: 'not found' }) : send(res, 200, { text });
        }
        if (m[2] === '/write' && req.method === 'POST') {
          const body = (await readBody(req)) as { data?: unknown };
          if (typeof body.data !== 'string') return send(res, 400, { error: 'data required' });
          return send(res, registry.write(id, body.data) ? 200 : 404, {});
        }
        if (!m[2] && req.method === 'POST') {
          const spec = await readBody(req);
          if (!isSpawnSpec(spec)) return send(res, 400, { error: 'invalid spawn spec' });
          if (!fs.existsSync(spec.cwd)) return send(res, 400, { error: 'cwd does not exist' });
          return send(res, 200, registry.spawn(id, spec));
        }
        if (!m[2] && req.method === 'GET') {
          const info = registry.get(id);
          return info ? send(res, 200, info) : send(res, 404, { error: 'not found' });
        }
        if (!m[2] && req.method === 'DELETE') {
          await registry.kill(id);
          return send(res, 200, {});
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = (req.url ?? '').match(ATTACH_PATH);
    if (!m || !authorized(req, url)) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(m[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const attached = registry.attach(
        id,
        (data) => {
          try { ws.send(Buffer.from(data, 'utf-8'), { binary: true }); } catch { /* */ }
        },
        (code) => {
          try {
            ws.send(JSON.stringify({ type: 'exit', code }));
            ws.close(1000);
          } catch { /* */ }
        },
      );
      if (!attached) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'no such pty' }));
          ws.close(1011);
        } catch { /* */ }
        return;
      }
      // Always first, even when empty: clients hold input and their own
      // resize until they've drawn it (see HostControlFrame 'replay').
      try {
        ws.send(JSON.stringify({ type: 'replay', ...attached.replay }));
      } catch { /* */ }
      if (attached.exitedWith !== null) {
        try {
          ws.send(JSON.stringify({ type: 'exit', code: attached.exitedWith }));
          ws.close(1000);
        } catch { /* */ }
        return;
      }
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let msg: ClientFrame;
        try {
          msg = JSON.parse(raw.toString('utf-8')) as ClientFrame;
        } catch {
          return;
        }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          registry.write(id, msg.data);
        } else if (
          msg.type === 'resize' &&
          Number.isInteger(msg.cols) &&
          Number.isInteger(msg.rows)
        ) {
          registry.resize(id, msg.cols, msg.rows);
        }
      });
      ws.on('close', () => attached.detach());
      ws.on('error', () => attached.detach());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const info: HostInfo = { pid: process.pid, port, token, version: PROTOCOL_VERSION };
  if (opts.writeInfo !== false) {
    atomicWriteFile(hostInfoPath(), JSON.stringify(info));
  }
  if (opts.restore !== false) {
    // An older host that outlived the upgrade kept its list in the old
    // file: take it over before restoring (see adoptLegacyRestoreList).
    if (!opts.registry) {
      const adopted = bestEffort('adopt the old pty-sessions.json', () => adoptLegacyRestoreList(), null);
      if (adopted !== null && adopted !== undefined) report('info', `[pty-host] adopted ${adopted} session(s) from an older host's pty-sessions.json`);
    }
    await registry.restore();
  }

  return {
    info,
    registry,
    async stop() {
      registry.disposeAllKeepingState();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      if (opts.writeInfo !== false) {
        try {
          const cur = JSON.parse(fs.readFileSync(hostInfoPath(), 'utf-8')) as HostInfo;
          if (cur.pid === process.pid) fs.unlinkSync(hostInfoPath());
        } catch { /* */ }
      }
    },
  };
}
