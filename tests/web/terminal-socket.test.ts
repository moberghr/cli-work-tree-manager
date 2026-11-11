// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { openTerminalSocket } from '../../src/web/src/api/terminal-socket.js';
import type { TerminalTicketWire } from '../../src/core/api-types.js';

/** The Terminal tab's connection: straight to the PTY host with a ticket, else work web's relay. */

class FakeWs extends EventTarget {
  static OPEN = 1;
  static made: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeWs.made.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
  serverOpen() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  serverSays(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  refused() {
    this.dispatchEvent(new Event('close'));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const relay = 'ws://127.0.0.1:54989/ws/sessions/s1/terminal';
function open(answer: TerminalTicketWire | null, force = false) {
  FakeWs.made = [];
  const asked: boolean[] = [];
  const socket = openTerminalSocket('s1', {
    force,
    relayUrl: relay,
    askTicket: async (_id, f) => (asked.push(f), answer),
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
  });
  socket.binaryType = 'arraybuffer';
  const messages: unknown[] = [];
  let closes = 0;
  socket.addEventListener('message', (e) => messages.push(e.data));
  socket.addEventListener('close', () => closes++);
  return { socket, messages, asked, closes: () => closes };
}

describe('openTerminalSocket', () => {
  it('goes straight to the PTY host with the ticket; what is sent before it opens goes once it does', async () => {
    const t = open({ url: 'ws://127.0.0.1:1/ptys/s1/attach?ticket=abc' }, true);
    expect(t.socket.route).toBeNull();
    await flush();
    expect(t.asked).toEqual([true]);
    const [ws] = FakeWs.made;
    expect(ws.url).toBe('ws://127.0.0.1:1/ptys/s1/attach?ticket=abc');
    expect(ws.binaryType).toBe('arraybuffer');
    expect(t.socket.route).toBe('direct');
    t.socket.send('{"type":"input","data":"a"}');
    ws.serverOpen();
    expect(ws.sent).toEqual(['{"type":"input","data":"a"}']);
    ws.serverSays('frame');
    expect(t.messages).toEqual(['frame']);
    t.socket.close();
    expect(ws.closed).toBe(true);
    expect(t.closes()).toBe(1);
  });

  it('a direct connection the host turns down (a stale ticket, a restarted host) falls back to the relay', async () => {
    const t = open({ url: 'ws://127.0.0.1:1/ptys/s1/attach?ticket=old' });
    await flush();
    FakeWs.made[0].refused();
    expect(FakeWs.made.map((w) => w.url)).toEqual(['ws://127.0.0.1:1/ptys/s1/attach?ticket=old', relay]);
    expect(t.socket.route).toBe('relay');
    expect(t.closes()).toBe(0); // the tab never saw the first one fail
    // Once open, a close is the connection's end (no fallback: the tab reconnects itself).
    FakeWs.made[1].serverOpen();
    FakeWs.made[1].refused();
    expect(t.closes()).toBe(1);
  });

  it('the relay when there is no ticket: an older work web or host, the demo, a failed request', async () => {
    for (const answer of [{ fallback: true } as const, null]) {
      const t = open(answer);
      await flush();
      expect(FakeWs.made.map((w) => w.url)).toEqual([relay]);
      expect(t.socket.route).toBe('relay');
    }
  });

  it('a Claude in another terminal, or a start refused: said as the relay would, then the end — nothing connected', async () => {
    const e = open({ elsewhere: { type: 'elsewhere', lastActivity: null, state: null } as never });
    await flush();
    expect(e.messages.map((m) => JSON.parse(m as string).type)).toEqual(['elsewhere']);
    expect(e.closes()).toBe(1);
    expect(FakeWs.made).toHaveLength(0);
    const r = open({ error: 'archived' });
    await flush();
    expect(r.messages.map((m) => JSON.parse(m as string))).toEqual([{ type: 'error', message: 'archived' }]);
    expect(r.closes()).toBe(1);
  });

  it('closed before the answer came: connects nothing', async () => {
    const t = open({ url: 'ws://127.0.0.1:1/ptys/s1/attach?ticket=abc' });
    t.socket.close();
    await flush();
    expect(FakeWs.made).toHaveLength(0);
    expect(t.closes()).toBe(1);
  });
});
