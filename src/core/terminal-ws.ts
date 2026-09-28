import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type EventEmitter from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { ensurePty } from './pty-pool.js';

const TERMINAL_PATH = /^\/ws\/sessions\/([^/]+)\/terminal$/;

/** Minimal contract over the Node `http.Server` we need — broad enough to
 *  accept both HTTP/1 and HTTP/2 servers from `@hono/node-server`. */
type UpgradableServer = EventEmitter;

/**
 * Attach a WebSocket handler to the same Node http server Hono is running
 * on. Listens for upgrade requests at /ws/sessions/:id/terminal, attaches
 * to (or spawns) that session's PTY, and bridges traffic both ways.
 *
 * Browser → server frames are JSON:
 *   { type: 'input', data: string }   stdin bytes
 *   { type: 'resize', cols, rows }    PTY resize
 *
 * Server → browser: binary frames are PTY output; text frames are control
 * JSON ({ type: 'exit', code } | { type: 'error', message }).
 *
 * `port` is the listening port — used for the Host-header DNS-rebinding
 * guard, mirroring the one applied to Hono routes in `diff-server.launch`.
 * The WS upgrade bypasses Hono entirely so it needs its own check.
 */
export function attachTerminalWs(
  httpServer: UpgradableServer,
  port: number,
): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head) => {
    const host = req.headers.host;
    if (!host || !allowedHosts.has(host)) {
      socket.destroy();
      return;
    }
    const url = req.url ?? '';
    const match = url.match(TERMINAL_PATH);
    if (!match) {
      socket.destroy();
      return;
    }
    const sessionId = decodeURIComponent(match[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      void bridgeToHost(ws, sessionId);
    });
  });

  return {
    close: () => wss.close(),
  };
}

/**
 * Pipe a browser terminal to the session's PTY in the PTY host. The host
 * owns the PTY; this is a dumb relay in both directions, so closing the
 * browser tab (or restarting `work web`) only drops the relay.
 *
 * Browser frames are already the host's ClientFrame JSON, so they pass
 * through verbatim.
 */
async function bridgeToHost(ws: WebSocket, sessionId: string): Promise<void> {
  let hostUrl: string | null;
  try {
    hostUrl = await ensurePty(sessionId);
  } catch (err) {
    hostUrl = null;
    try { ws.send(JSON.stringify({ type: 'error', message: (err as Error).message })); } catch { /* */ }
  }
  if (!hostUrl) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: 'unknown session' }));
      ws.close(1011);
    } catch { /* */ }
    return;
  }

  const upstream = new WebSocket(hostUrl);
  const queued: string[] = [];
  upstream.on('open', () => {
    for (const q of queued) upstream.send(q);
    queued.length = 0;
  });
  // Binary = PTY output, text = control JSON (exit/error) — same framing
  // on both hops, so frames pass through untouched.
  upstream.on('message', (data, isBinary) => {
    try {
      ws.send(data as Buffer, { binary: isBinary });
    } catch { /* browser gone */ }
  });
  upstream.on('close', () => {
    try { ws.close(); } catch { /* */ }
  });
  upstream.on('error', () => {
    try { ws.close(1011); } catch { /* */ }
  });

  ws.on('message', (raw) => {
    const text = raw.toString('utf-8');
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push(text);
  });
  const drop = () => {
    try { upstream.close(); } catch { /* */ }
  };
  ws.on('close', drop);
  ws.on('error', drop);
}
