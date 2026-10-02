import type { IncomingMessage } from 'node:http';
import { sessionStatusView } from './turn-activity.js';
import type { Socket } from 'node:net';
import type EventEmitter from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { ensurePty, peekPty, ptyPids, syncPtyPool } from './pty-pool.js';
import { claudesBySession, readLiveClaudes } from './live-claudes.js';
import { loadHistory } from './history.js';
import { refuseReason } from './local-origin.js';
import { findSession } from './web-state.js';
import { readSessionActivity } from './claude-activity.js';
import { readStatus } from './session-status.js';
import type { TerminalElsewhere } from './api-types.js';

const TERMINAL_PATH = /^\/ws\/sessions\/([^/]+)\/terminal(?:\?(.*))?$/;

/** Minimal contract over the Node `http.Server` we need — broad enough to
 *  accept both HTTP/1 and HTTP/2 servers from `@hono/node-server`. */
type UpgradableServer = EventEmitter;

/** Transcript written this recently → a Claude is running there. */
export const ELSEWHERE_ACTIVE_MS = 5 * 60_000;
/** A Stop this recent → its Claude is most likely still open at its prompt. */
export const ELSEWHERE_IDLE_MS = 30 * 60_000;

export interface ElsewhereInput {
  /** The PTY host already runs this session's Claude. */
  hasPty: boolean;
  /** Claude's last transcript write (ms since epoch), or null. */
  lastActivityMs: number | null;
  /** The session's effective hook status, or null. `endedAt`: when its last
   *  turn ended (the Stop) — not `updatedAt`, which also moves when you open
   *  the session (seen) or on Claude Code's idle nudge, neither a sign that a
   *  Claude is still open somewhere. */
  status: { state: 'working' | 'needs_input' | 'idle'; updatedAt: string; endedAt?: string } | null;
  /** Claudes running for this session outside the PTY host, known for sure
   *  from Claude Code's own process files (live-claudes.ts). */
  runningOutside?: Array<{ busy: boolean }>;
}

/**
 * Is this session's Claude running OUTSIDE the PTY host — in a plain
 * terminal, started without `--host`? Spawning one in the host then would
 * put a second Claude on the same conversation (`--continue`), which broke
 * the user's real terminal. The host has no view of foreign processes, so
 * this is inferred: a fresh transcript write, a status that says it is
 * working or blocked on a prompt (a blocked one sits silent for hours), or
 * a Stop within the last half hour. Quiet longer than that: unknown, and
 * spawning (which resumes the conversation) is what the tab is for.
 */
export function claudeElsewhere(i: ElsewhereInput, now = Date.now()): TerminalElsewhere | null {
  if (i.hasPty) return null;
  const outside = i.runningOutside ?? [];
  if (outside.length > 0) {
    // Not a guess: one is running, however quiet. A second would share its conversation.
    return { type: 'elsewhere', lastActivity: i.lastActivityMs, state: i.status?.state ?? (outside.some((c) => c.busy) ? 'working' : null), confirmed: true };
  }
  const active = i.lastActivityMs !== null && now - i.lastActivityMs < ELSEWHERE_ACTIVE_MS;
  const s = i.status;
  const blockedOrWorking = !!s && (s.state === 'needs_input' || s.state === 'working');
  const justFinished = !!s && s.state === 'idle' && now - (Date.parse(s.endedAt ?? s.updatedAt) || 0) < ELSEWHERE_IDLE_MS;
  if (!active && !blockedOrWorking && !justFinished) return null;
  return { type: 'elsewhere', lastActivity: i.lastActivityMs, state: s?.state ?? null };
}

async function defaultElsewhere(sessionId: string): Promise<TerminalElsewhere | null> {
  // Which Claudes the host runs must be current: right after a work web
  // restart the pool's list is still empty, and the host's own Claude would
  // count as running "elsewhere".
  await syncPtyPool();
  const session = findSession(sessionId);
  if (!session) return null;
  const activity = readSessionActivity(session);
  const raw = readStatus(sessionId);
  const status = raw ? sessionStatusView(raw, session, activity.lastActivity ?? 0) : null;
  const hostPids = ptyPids();
  const runningOutside = (claudesBySession(readLiveClaudes(), loadHistory()).get(sessionId) ?? []).filter((c) => !hostPids.has(c.pid));
  return claudeElsewhere({
    hasPty: peekPty(sessionId),
    lastActivityMs: activity.lastActivity,
    // The turn's end: the Stop's own time, else when it went idle (a record from before turnEndedAt).
    status: status ? { state: status.state, updatedAt: status.updatedAt, endedAt: raw?.turnEndedAt ?? status.since } : null,
    runningOutside,
  });
}

export interface TerminalWsOptions {
  /** Whether the session's Claude runs outside the host (tests inject). */
  elsewhere?: (sessionId: string) => TerminalElsewhere | null | Promise<TerminalElsewhere | null>;
}

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
 * JSON ({ type: 'exit', code } | { type: 'error', message } |
 * { type: 'elsewhere', … } — the session's Claude runs in another terminal,
 * nothing was spawned; `?force=1` spawns anyway).
 *
 * `port` is the listening port — used for the same Host + Origin guard the
 * Hono routes get in `diff-server.launch` (core/local-origin.ts). The WS
 * upgrade bypasses Hono entirely so it needs its own check.
 */
export function attachTerminalWs(
  httpServer: UpgradableServer,
  port: number,
  opts: TerminalWsOptions = {},
): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const elsewhere = opts.elsewhere ?? defaultElsewhere;

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head) => {
    // WebSockets aren't covered by CORS: without this, any page open in
    // the browser could connect and type into Claude. Browsers always send
    // Origin on a WebSocket, so a foreign page is refused here.
    const reason = refuseReason(
      {
        method: 'GET',
        upgrade: true,
        host: req.headers.host,
        origin: req.headers.origin,
        secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
        secFetchMode: req.headers['sec-fetch-mode'] as string | undefined,
        secFetchDest: req.headers['sec-fetch-dest'] as string | undefined,
      },
      port,
    );
    if (reason) {
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
    const force = new URLSearchParams(match[2] ?? '').get('force') === '1';
    wss.handleUpgrade(req, socket, head, (ws) => {
      void bridgeToHost(ws, sessionId, force ? null : elsewhere(sessionId));
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
async function bridgeToHost(
  ws: WebSocket,
  sessionId: string,
  pending: TerminalElsewhere | null | Promise<TerminalElsewhere | null>,
): Promise<void> {
  const elsewhere = await pending;
  // The browser may have left while that was being worked out.
  if (ws.readyState !== WebSocket.OPEN) return;
  if (elsewhere) {
    // Nothing spawned: the tab explains and offers to force it.
    try {
      ws.send(JSON.stringify(elsewhere));
      ws.close(1000);
    } catch { /* */ }
    return;
  }
  // The browser may leave while ensurePty() is still starting the host (up
  // to several seconds): track that from the start, or the upstream opened
  // afterwards would never be closed — a leaked host connection with a live
  // subscriber.
  let browserGone = false;
  let upstream: WebSocket | null = null;
  const drop = () => {
    browserGone = true;
    try { upstream?.close(); } catch { /* */ }
  };
  ws.on('close', drop);
  ws.on('error', drop);

  let hostUrl: string | null;
  try {
    hostUrl = await ensurePty(sessionId);
  } catch (err) {
    // Said once, with the reason (an archived session, a host that won't start).
    try {
      ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
      ws.close(1011);
    } catch { /* */ }
    return;
  }
  if (!hostUrl) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: 'unknown session' }));
      ws.close(1011);
    } catch { /* */ }
    return;
  }

  if (browserGone) return;
  upstream = new WebSocket(hostUrl);
  const up = upstream;
  const queued: string[] = [];
  up.on('open', () => {
    for (const q of queued) up.send(q);
    queued.length = 0;
  });
  // Binary = PTY output, text = control JSON (exit/error) — same framing
  // on both hops, so frames pass through untouched.
  up.on('message', (data, isBinary) => {
    try {
      ws.send(data as Buffer, { binary: isBinary });
    } catch { /* browser gone */ }
  });
  up.on('close', () => {
    try { ws.close(); } catch { /* */ }
  });
  up.on('error', () => {
    try { ws.close(1011); } catch { /* */ }
  });

  ws.on('message', (raw) => {
    const text = raw.toString('utf-8');
    if (up.readyState === WebSocket.OPEN) up.send(text);
    else if (up.readyState === WebSocket.CONNECTING) queued.push(text);
  });
}
