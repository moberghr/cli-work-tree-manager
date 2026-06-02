import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type EventEmitter from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { getOrCreatePty } from './pty-pool.js';

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
 * Server → browser frames are binary (PTY output, sent as utf-8 strings).
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
      const pty = getOrCreatePty(sessionId);
      if (!pty) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'unknown session' }));
          ws.close(1011);
        } catch { /* */ }
        return;
      }
      handleConnection(ws, pty);
    });
  });

  return {
    close: () => wss.close(),
  };
}

function handleConnection(
  ws: WebSocket,
  pty: ReturnType<typeof getOrCreatePty> & object,
): void {
  // Replay first so the browser sees existing scrollback immediately.
  const replay = pty.replay();
  if (replay) {
    try { ws.send(replay); } catch { /* */ }
  }

  const unsubscribe = pty.subscribe((data) => {
    try { ws.send(data); } catch { /* client gone */ }
  });

  ws.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString('utf-8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as {
      type?: string;
      data?: string;
      cols?: number;
      rows?: number;
    };
    if (m.type === 'input' && typeof m.data === 'string') {
      pty.write(m.data);
    } else if (
      m.type === 'resize' &&
      typeof m.cols === 'number' &&
      typeof m.rows === 'number'
    ) {
      pty.resize(m.cols, m.rows);
    }
  });

  ws.on('close', () => {
    unsubscribe();
  });
  ws.on('error', () => {
    unsubscribe();
  });
}
