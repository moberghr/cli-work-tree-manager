import type { TerminalTicketWire } from '../../../core/api-types.js';

/**
 * The Terminal tab's connection: straight to the PTY host when it can, else through work web's relay as before.
 *
 * It asks work web where to connect (`POST /api/terminals/:id/ticket`, terminal-routes.ts): work web does its checks
 * — a Claude running in another terminal, starting the agent — and answers the host's address with a one-time ticket,
 * so keystrokes and echoes never wait on work web's event loop (reported: typing lagged in the app while `work attach`
 * on the same host was smooth). The answer may also be the other terminal ("elsewhere") or why it couldn't start,
 * which reach the tab as the relay would have sent them. Anything else — an older work web or host, the demo, a
 * failed request, a direct connection that never opened — goes through the relay. The tab sees one socket either way:
 * the members of a WebSocket it uses.
 */

export interface TerminalSocket {
  binaryType: BinaryType;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  addEventListener(type: 'close', listener: (e: Event) => void): void;
  send(data: string): void;
  close(): void;
  /** Where it ended up: straight to the PTY host, or through work web; null while it's being worked out. */
  readonly route: 'direct' | 'relay' | null;
}

export interface TerminalSocketOptions {
  /** Start it even though its Claude seems to run in another terminal (the tab's "start it here"). */
  force: boolean;
  /** work web's relay (`/ws/sessions/:id/terminal`), for when there's no direct way. */
  relayUrl: string;
  /** Tests: the ticket request. */
  askTicket?: (sessionId: string, force: boolean) => Promise<TerminalTicketWire | null>;
  /** Tests: the WebSocket class. */
  WebSocketImpl?: typeof WebSocket;
}

export async function askTerminalTicket(sessionId: string, force: boolean): Promise<TerminalTicketWire | null> {
  try {
    const res = await fetch(`/api/terminals/${encodeURIComponent(sessionId)}/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    // An older work web (404) or anything unexpected: the relay.
    if (res.status === 404 && !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as TerminalTicketWire;
  } catch {
    return null;
  }
}

export function openTerminalSocket(sessionId: string, opts: TerminalSocketOptions): TerminalSocket {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const ask = opts.askTicket ?? askTerminalTicket;
  const onMessage: Array<(e: MessageEvent) => void> = [];
  const onClose: Array<(e: Event) => void> = [];
  const queued: string[] = [];
  let ws: WebSocket | null = null;
  let closed = false;
  let ended = false;
  let route: 'direct' | 'relay' | null = null;

  const message = (data: unknown) => {
    const e = new MessageEvent('message', { data });
    for (const l of onMessage) l(e);
  };
  const end = (e: Event = new Event('close')) => {
    if (ended) return;
    ended = true;
    for (const l of onClose) l(e);
  };

  const connect = (url: string, direct: boolean) => {
    if (closed) return;
    route = direct ? 'direct' : 'relay';
    const sock = new Impl(url);
    sock.binaryType = socket.binaryType;
    ws = sock;
    let opened = false;
    sock.addEventListener('open', () => {
      opened = true;
      for (const q of queued) sock.send(q);
      queued.length = 0;
    });
    sock.addEventListener('message', (e) => {
      if (ws === sock) for (const l of onMessage) l(e as MessageEvent);
    });
    sock.addEventListener('close', (e) => {
      if (ws !== sock) return;
      // The host turned the direct connection down (a stale ticket, a host restarted meanwhile): the relay instead.
      if (direct && !opened && !closed) return connect(opts.relayUrl, false);
      end(e);
    });
  };

  const socket: TerminalSocket = {
    binaryType: 'blob',
    addEventListener(type: 'message' | 'close', listener: (e: never) => void) {
      if (type === 'message') onMessage.push(listener as (e: MessageEvent) => void);
      else onClose.push(listener as (e: Event) => void);
    },
    send(data: string) {
      if (ws && ws.readyState === Impl.OPEN) ws.send(data);
      else queued.push(data);
    },
    close() {
      closed = true;
      if (ws) ws.close();
      else end();
    },
    get route() {
      return route;
    },
  };

  void ask(sessionId, opts.force).then((answer) => {
    if (closed) return;
    if (answer && 'url' in answer) return connect(answer.url, true);
    // As the relay would have said it: the tab explains, or shows why, then sees the connection end.
    if (answer && 'elsewhere' in answer) {
      message(JSON.stringify(answer.elsewhere));
      return end();
    }
    if (answer && 'error' in answer) {
      message(JSON.stringify({ type: 'error', message: answer.error }));
      return end();
    }
    connect(opts.relayUrl, false);
  });
  return socket;
}
