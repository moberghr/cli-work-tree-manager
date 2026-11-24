import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachSession } from '../../../src/commands/shared/attach-session.js';
import { PtyHostClient } from '../../../src/core/pty/pty-host-client.js';
import { TERMINAL_RESET } from '../../../src/core/pty/terminal-reset.js';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';

/**
 * `work attach`'s bridge (attach-session.ts) against a stand-in socket and terminal: the address it attaches at, the
 * resize it sends after the first screen (only when that screen was drawn at another grid), and the terminal reset on
 * the way out (only into a terminal).
 */

type FakeSocket = { url: string; sent: string[]; open(): void; message(frame: object): void; close(): void };
const h = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));

vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class WebSocket extends Emitter {
    static readonly OPEN = 1;
    readyState = 0;
    readonly sent: string[] = [];
    constructor(readonly url: string) {
      super();
      h.sockets.push(this);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    open(): void {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    }
    message(frame: object): void {
      this.emit('message', Buffer.from(JSON.stringify(frame)), false);
    }
    close(): void {
      this.readyState = 3;
      this.emit('close');
    }
  }
  return { WebSocket };
});
vi.mock('../../../src/core/pty/pty-host-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/pty/pty-host-client.js')>()),
  ensureHost: vi.fn(async () => ({ port: 4321, token: 'tok', pid: 1 })),
}));
vi.mock('../../../src/core/pty/pty-pool.js', () => ({ spawnSpecFor: () => ({ cwd: '/wt', tool: { cmd: 'claude' } }) }));
vi.mock('../../../src/core/platform/work-bin.js', () => ({ resolveWorkBinPath: () => '/work' }));

const session: WorktreeSession = {
  target: 'repo',
  isGroup: false,
  branch: 'feat/x',
  paths: ['/wt'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-01T00:00:00.000Z',
};

let written: string[];
const stdin = Object.assign(new EventEmitter(), {
  isTTY: false,
  setRawMode: vi.fn(),
  resume: vi.fn(),
  pause: vi.fn(),
  destroy: vi.fn(),
});
const shown = { columns: 100, rows: 30, isTTY: false };
const SHOWN = ['columns', 'rows', 'isTTY'] as const;
const saved = new Map<(typeof SHOWN)[number], PropertyDescriptor | undefined>();

beforeEach(() => {
  h.sockets.length = 0;
  written = [];
  stdin.removeAllListeners();
  shown.columns = 100;
  shown.rows = 30;
  shown.isTTY = false;
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  // Not a terminal in a test worker: the stream has none of these of its own to spy on.
  for (const key of SHOWN) {
    saved.set(key, Object.getOwnPropertyDescriptor(process.stdout, key));
    Object.defineProperty(process.stdout, key, { configurable: true, get: () => shown[key] });
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(((data: string | Uint8Array, done?: () => void) => {
    written.push(String(data));
    done?.();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(PtyHostClient.prototype, 'get').mockResolvedValue(null);
  vi.spyOn(PtyHostClient.prototype, 'spawn').mockResolvedValue(undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, was] of saved) {
    if (was) Object.defineProperty(process.stdout, key, was);
    else delete (process.stdout as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
});

/** Attached: the socket it opened, open. */
async function attached(): Promise<{ ws: FakeSocket; done: Promise<number> }> {
  const done = attachSession(session);
  const ws = await vi.waitFor(() => {
    expect(h.sockets).toHaveLength(1);
    return h.sockets[0];
  });
  ws.open();
  return { ws, done };
}

const resizes = (ws: FakeSocket) => ws.sent.map((f) => JSON.parse(f) as { type: string }).filter((f) => f.type === 'resize');

describe('work attach: the bridge to a session in the PTY host', () => {
  it('attaches acking what it drew, with catch-up screens only, at this terminal’s grid', async () => {
    const { ws, done } = await attached();
    const url = new URL(ws.url);
    expect(url.port).toBe('4321');
    expect(url.pathname).toMatch(/^\/ptys\/[^/]+\/attach$/);
    expect(url.searchParams.get('flow')).toBe('1');
    expect(url.searchParams.get('catchup')).toBe('screen');
    expect(url.searchParams.get('cols')).toBe('100');
    expect(url.searchParams.get('rows')).toBe('30');
    ws.close();
    await done;
  });

  it('a first screen drawn at this terminal’s grid sends no resize', async () => {
    const { ws, done } = await attached();
    ws.message({ type: 'replay', data: 'screen', cols: 100, rows: 30 });
    expect(resizes(ws)).toEqual([]);
    expect(written.join('')).toContain('screen');
    ws.close();
    await done;
  });

  it('a first screen drawn at another grid sends this terminal’s grid once; a later screen sends none', async () => {
    const { ws, done } = await attached();
    ws.message({ type: 'replay', data: 'screen', cols: 80, rows: 24 });
    expect(resizes(ws)).toEqual([{ type: 'resize', cols: 100, rows: 30 }]);
    // It fell behind and caught up: that screen is only drawn, whatever grid it was taken at.
    ws.message({ type: 'replay', data: 'caught up', cols: 80, rows: 24 });
    expect(resizes(ws)).toHaveLength(1);
    expect(written.join('')).toContain('caught up');
    ws.close();
    await done;
  });

  it('resets the agent’s terminal modes on the way out into a terminal, and writes no reset into a file or pipe', async () => {
    shown.isTTY = true;
    const tty = await attached();
    tty.ws.message({ type: 'exit', code: 3 });
    tty.ws.close();
    expect(await tty.done).toBe(3);
    expect(written).toContain(TERMINAL_RESET);

    shown.isTTY = false;
    written.length = 0;
    h.sockets.length = 0;
    const piped = await attached();
    piped.ws.message({ type: 'exit', code: 0 });
    piped.ws.close();
    expect(await piped.done).toBe(0);
    expect(written.join('')).not.toContain(TERMINAL_RESET);
  });
});
