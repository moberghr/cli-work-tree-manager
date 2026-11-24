// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- xterm fakes -----------------------------------------------------------

const h = vi.hoisted(() => {
  const FIT = { cols: 100, rows: 30 };
  /** The pane's size in pixels (jsdom lays nothing out: every element measures this). 0 × 0 = not laid out. */
  const PANE = { width: 800, height: 600 };
  const terms: FakeTerminal[] = [];
  /** What each tab asked openTerminalSocket for. */
  const socketOpts: Array<{ flow?: boolean; force?: boolean; grid?: { cols: number; rows: number } | null; resume?: unknown }> = [];
  let webglThrows = false;
  /** What the page's WebGL gate says (webgl-gate.ts): null = may use it, 'software' = a software rasterizer. */
  const gate = { refusal: null as 'software' | null };

  type KeyHandler = (e: KeyboardEvent) => boolean;

  class FakeTerminal {
    cols = 80;
    rows = 24;
    writes: string[] = [];
    resizes: Array<[number, number]> = [];
    unicode = { activeVersion: '6' };
    keyHandler: KeyHandler | null = null;
    dataCb: ((d: string) => void) | null = null;
    selection = '';
    disposed = false;
    /** The hidden input xterm types into (paste and focus arrive on it). */
    textarea = document.createElement('textarea');
    /** Its root (the browser's copy event arrives on it). */
    element = document.createElement('div');
    /** Its cells (none here: the copy falls back to the plain selection, as it does when they disagree), and where the
     *  view is: `viewportY` < `baseY` = scrolled up into the scrollback. */
    buffer = {
      active: {
        getLine: (_y: number): { translateToString(trimRight?: boolean): string } | undefined => undefined,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        type: 'normal' as 'normal' | 'alternate',
      },
    };
    /** xterm's parser hooks; `csi` runs a sequence through them, the last registered first, as xterm does. */
    private csiHooks: Array<{ id: { prefix?: string; final: string }; cb: (params: (number | number[])[]) => boolean }> = [];
    private escHooks: Array<{ id: { final: string }; cb: () => boolean }> = [];
    parser = {
      registerCsiHandler: (id: { prefix?: string; final: string }, cb: (params: (number | number[])[]) => boolean) => {
        const hook = { id, cb };
        this.csiHooks.unshift(hook);
        return { dispose: () => void (this.csiHooks = this.csiHooks.filter((x) => x !== hook)) };
      },
      registerEscHandler: (id: { final: string }, cb: () => boolean) => {
        const hook = { id, cb };
        this.escHooks.unshift(hook);
        return { dispose: () => void (this.escHooks = this.escHooks.filter((x) => x !== hook)) };
      },
    };
    /** Returns whether xterm's own handler got the sequence too (no hook claimed it). */
    csi(final: string, params: number[], prefix?: string): boolean {
      for (const hook of this.csiHooks) if (hook.id.final === final && hook.id.prefix === prefix && hook.cb(params)) return false;
      return true;
    }
    esc(final: string): boolean {
      for (const hook of this.escHooks) if (hook.id.final === final && hook.cb()) return false;
      return true;
    }
    get hooks(): number {
      return this.csiHooks.length + this.escHooks.length;
    }
    /** The buffer's lines (the view is `rows` of them from `viewportY`): baseY = lines − rows. */
    setLines(lines: string[], viewportY: number | 'bottom') {
      const b = this.buffer.active;
      b.getLine = (y) => (y >= 0 && y < lines.length ? { translateToString: () => lines[y]! } : undefined);
      b.baseY = Math.max(0, lines.length - this.rows);
      b.viewportY = viewportY === 'bottom' ? b.baseY : viewportY;
    }
    options: Record<string, unknown> = {};
    /** Each value `options.fontFamily` was set to, and how often the glyph atlas was cleared. */
    fontFamilies: unknown[] = [];
    atlasCleared = 0;
    clearTextureAtlas() {
      this.atlasCleared += 1;
    }
    /** How many lines a resize moves the scrollback by (a reflow): markers move with it, as xterm's do. */
    reflowShift = 0;
    markers: Array<{ line: number; isDisposed: boolean; dispose(): void }> = [];
    scrolledTo: Array<number | 'bottom'> = [];
    registerMarker(offset: number) {
      const b = this.buffer.active;
      const marker = {
        line: b.baseY + b.cursorY + offset,
        isDisposed: false,
        dispose() {
          this.isDisposed = true;
        },
      };
      this.markers.push(marker);
      return marker;
    }
    scrollToLine(line: number) {
      this.scrolledTo.push(line);
      this.buffer.active.viewportY = line;
    }
    scrollToBottom() {
      this.scrolledTo.push('bottom');
      this.buffer.active.viewportY = this.buffer.active.baseY;
    }
    /** Where the selection starts (its column: the first line's text began there). */
    selectionStart = { x: 0, y: 0 };
    constructor(readonly opts: unknown) {
      terms.push(this);
    }
    loadAddon(a: { activate?: (t: FakeTerminal) => void }) {
      a.activate?.(this);
    }
    open() {}
    focused = 0;
    focus() {
      this.focused++;
    }
    resize(c: number, r: number) {
      this.cols = c;
      this.rows = r;
      this.resizes.push([c, r]);
      // A reflow moves the lines; the view itself lands wherever xterm puts it (here: the top, the worst case).
      this.buffer.active.baseY += this.reflowShift;
      this.buffer.active.viewportY = 0;
      for (const m of this.markers) if (!m.isDisposed) m.line += this.reflowShift;
    }
    /** Writes parsed later, when the test says (`parsed()`), as xterm's are: their callbacks wait until then. */
    deferWrites = false;
    private unparsed: Array<() => void> = [];
    write(data: string | Uint8Array, cb?: () => void) {
      this.writes.push(typeof data === 'string' ? data : new TextDecoder('latin1').decode(data));
      if (!cb) return;
      if (this.deferWrites) this.unparsed.push(cb);
      else cb();
    }
    parsed() {
      for (const cb of this.unparsed.splice(0)) cb();
    }
    /** The next write parsed (its callback run), and only it. */
    parseOne() {
      this.unparsed.shift()?.();
    }
    // A frame drawn (the latency meter's "on screen"); tests call it to draw one.
    renderCb: (() => void) | null = null;
    onRender(cb: () => void) {
      this.renderCb = cb;
      return {
        dispose: () => {
          this.renderCb = null;
        },
      };
    }
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
      return {
        dispose: () => {
          this.dataCb = null;
        },
      };
    }
    attachCustomKeyEventHandler(fn: KeyHandler) {
      this.keyHandler = fn;
    }
    hasSelection() {
      return this.selection.length > 0;
    }
    getSelection() {
      return this.selection;
    }
    getSelectionPosition() {
      return this.selection ? { start: this.selectionStart, end: this.selectionStart } : undefined;
    }
    clearSelection() {
      this.selection = '';
    }
    dispose() {
      this.disposed = true;
    }
    /** Simulate typing (what xterm's onData emits). */
    type(d: string) {
      this.dataCb?.(d);
    }
  }

  class FakeFit {
    private t: FakeTerminal | null = null;
    activate(t: FakeTerminal) {
      this.t = t;
    }
    fit() {
      if (!this.t) return;
      this.t.cols = FIT.cols;
      this.t.rows = FIT.rows;
    }
    /** What fits the pane (FitAddon's: 2 × 1 for an empty one, whatever the cell size says otherwise). */
    proposeDimensions() {
      if (!this.t) return undefined;
      return PANE.width > 0 && PANE.height > 0 ? { ...FIT } : { cols: 2, rows: 1 };
    }
  }

  const webgls: FakeWebgl[] = [];
  class FakeWebgl {
    disposed = false;
    private lossCb: (() => void) | null = null;
    constructor() {
      if (webglThrows) throw new Error('no webgl');
      webgls.push(this);
    }
    onContextLoss(cb: () => void) {
      this.lossCb = cb;
    }
    dispose() {
      this.disposed = true;
    }
    /** Simulate a GPU reset. */
    loseContext() {
      this.lossCb?.();
    }
  }

  return {
    FIT,
    PANE,
    terms,
    socketOpts,
    webgls,
    FakeTerminal,
    FakeFit,
    FakeWebgl,
    gate,
    setWebglThrows: (v: boolean) => {
      webglThrows = v;
    },
  };
});

vi.mock('@xterm/xterm', () => ({ Terminal: h.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: h.FakeFit }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: h.FakeWebgl }));
// jsdom has no WebGL to probe: the gate answers what a test says.
vi.mock('../../src/web/src/state/webgl-gate.js', () => ({ pageWebglRefusal: () => h.gate.refusal }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
// The libghostty-vt engine (its own chunk, loaded only when picked): here it can't be had, so xterm.js draws.
vi.mock('../../src/web/src/components/Terminal/engine/ghostty-engine.js', () => ({
  createGhosttyEngine: () => Promise.reject(new Error('no module')),
}));
// The tab's own connection, straight from its relay address (terminal-socket.ts has its own tests: the ticket, the
// direct connection to the PTY host, the fallback): these drive the socket as the relay's.
vi.mock('../../src/web/src/api/terminal-socket.js', () => ({
  openTerminalSocket: (_id: string, opts: { relayUrl: string; flow?: boolean; grid?: { cols: number; rows: number } | null }) => {
    h.socketOpts.push(opts);
    const ws = new (globalThis as unknown as { WebSocket: new (url: string) => WebSocket }).WebSocket(opts.relayUrl);
    Object.defineProperty(ws, 'route', { value: 'relay' });
    return ws;
  },
}));

// ---- WebSocket fake ----------------------------------------------------------

type Listener = (e: { data?: unknown }) => void;
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  // helpers
  serverOpen() {
    this.readyState = 1;
    this.emit('open');
  }
  control(frame: object) {
    this.emit('message', JSON.stringify(frame));
  }
  binary(text: string) {
    // Build the buffer in this realm: TextEncoder's can come from jsdom's,
    // which fails PtyView's `instanceof ArrayBuffer` check.
    const buf = new ArrayBuffer(text.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i);
    this.emit('message', buf);
  }
  serverClose() {
    this.readyState = 3;
    this.emit('close');
  }
}

import {
  ELSEWHERE_RECHECK_MS,
  PtyView,
  RECONNECT_COVER_MS,
  RECONNECT_DELAYS_MS,
  WRITE_PIECE,
  openLink,
} from '../../src/web/src/components/Terminal/PtyView.js';
import { ACK_EVERY } from '../../src/core/pty/flow-control.js';
import { WEBGL_RETRY_MS } from '../../src/web/src/state/webgl-recovery.js';
import { requestTerminalReconnect } from '../../src/web/src/state/terminal-reconnect.js';
import { FIT_MIN_MS } from '../../src/web/src/state/fit-scheduler.js';
import { WEBGL_RELEASE_MS } from '../../src/web/src/state/webgl-renderer.js';
import { FONT_SETTLE_MS } from '../../src/web/src/state/font-settle.js';

let container: HTMLDivElement;
let root: Root;
const realWebSocket = globalThis.WebSocket;

// jsdom lays nothing out (every clientWidth is 0): the pane measures PANE.
const paneSize = (dim: 'width' | 'height') => ({ configurable: true, get: () => h.PANE[dim] });

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', paneSize('width'));
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', paneSize('height'));
  Object.assign(h.PANE, { width: 800, height: 600 });
  Object.assign(h.FIT, { cols: 100, rows: 30 });
  h.socketOpts.length = 0;
  h.terms.length = 0;
  h.webgls.length = 0;
  h.setWebglThrows(false);
  h.gate.refusal = null;
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

function mount(sessionId = 's1') {
  act(() => {
    root.render(createElement(PtyView, { sessionId }));
  });
  const ws = FakeWebSocket.instances.at(-1)!;
  const term = h.terms.at(-1)!;
  return { ws, term };
}

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('PtyView', () => {
  it('connects to the session terminal endpoint', () => {
    const { ws } = mount('abc');
    expect(ws.url).toMatch(/\/ws\/sessions\/abc\/terminal$/);
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('takes keyboard focus at once, so an answer to Claude goes to Claude (not to j/k/n)', () => {
    const { term } = mount();
    expect(term.focused).toBeGreaterThan(0);
  });

  it('sends nothing before the replay frame, queueing typed input', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => term.type('a'));
    act(() => term.type('b'));
    expect(ws.sent).toEqual([]);
  });

  it('draws the replay at its own grid, then sends the fitted size and flushes input in order', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => term.type('a'));
    act(() => term.type('b'));
    // An older host's: drawn for another grid (it ignored the one stated on the address).
    act(() => ws.control({ type: 'replay', data: '<screen>', cols: 120, rows: 40 }));

    // At the pane's grid to attach, at the screen's to draw it, then the pane's again together with the PTY's.
    expect(term.resizes).toEqual([
      [h.FIT.cols, h.FIT.rows],
      [120, 40],
      [h.FIT.cols, h.FIT.rows],
    ]);
    expect(term.writes).toContain('<screen>');
    expect(ws.sent).toEqual([
      { type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows },
      { type: 'input', data: 'a' },
      { type: 'input', data: 'b' },
    ]);

    // After replay, input goes straight through.
    act(() => term.type('c'));
    expect(ws.sent.at(-1)).toEqual({ type: 'input', data: 'c' });
  });

  it('finishes an empty replay without writing', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    expect(ws.sent).toEqual([{ type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows }]);
    expect(term.resizes).toEqual([[h.FIT.cols, h.FIT.rows]]); // the attach grid only
    expect(term.writes).toEqual([]);
  });

  it('writes binary frames as PTY output', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.binary('hello'));
    expect(term.writes).toContain('hello');
  });

  it('asks to be paced, and acks what xterm has finished parsing, every ACK_EVERY characters (counted as the host counts them)', () => {
    const { ws, term } = mount();
    expect(h.socketOpts.at(-1)?.flow).toBe(true);
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x'.repeat(ACK_EVERY), cols: 80, rows: 24 }));
    term.deferWrites = true;
    const acks = () => ws.sent.filter((m) => (m as { type: string }).type === 'ack');
    act(() => ws.binary('a'.repeat(ACK_EVERY - 1)));
    act(() => ws.binary('\xc3\xa9'.repeat(10))); // é: two bytes, one character
    expect(acks()).toEqual([]); // received, not yet drawn — and a screen is never acked
    act(() => term.parsed());
    expect(acks()).toEqual([{ type: 'ack', chars: ACK_EVERY + 9 }]);
  });

  it('writes a big frame to xterm in pieces (it parses a write whole), acking each as it is drawn', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    const before = term.writes.length;
    act(() => ws.binary('y'.repeat(WRITE_PIECE * 2 + 10)));
    expect(term.writes.slice(before).map((w) => w.length)).toEqual([WRITE_PIECE, WRITE_PIECE, 10]);
    expect(ws.sent.filter((m) => (m as { type: string }).type === 'ack')).toEqual([
      { type: 'ack', chars: WRITE_PIECE },
      { type: 'ack', chars: WRITE_PIECE },
    ]);
  });

  it('a screen sent mid-session (it fell behind and caught up) is drawn over a reset terminal, and nothing else: no focus, no size, no input held', () => {
    vi.useFakeTimers();
    try {
      const { ws, term } = mount();
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: '<first>', cols: 120, rows: 40 }));
      act(() => term.type('k'));
      const sent = [...ws.sent];
      const focused = term.focused;
      act(() => ws.binary('stale'));
      // The PTY's grid now: another window's (the terminal in use sets it).
      act(() => ws.control({ type: 'replay', data: '<caught up>', cols: 90, rows: 20 }));
      act(() => void vi.advanceTimersByTime(1000));
      // Drawn at its grid, after a reset (RIS: in order with what was written before it, the scrollback cleared too),
      // and left at it: the agent's frame is for that grid, and fitting here alone would reflow it into garbage.
      expect(term.resizes.at(-1)).toEqual([90, 20]);
      expect(term.writes.at(-1)).toBe('\x1bc<caught up>');
      expect([term.cols, term.rows]).toEqual([90, 20]);
      expect(ws.sent).toEqual(sent);
      expect(term.focused).toBe(focused);
      // Typing goes straight on, as before.
      act(() => term.type('z'));
      expect(ws.sent.at(-1)).toEqual({ type: 'input', data: 'z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a screen sent mid-session, a pane that changed size changes both grids together', () => {
    vi.useFakeTimers();
    try {
      const { ws, term } = mount();
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: '<first>', cols: h.FIT.cols, rows: h.FIT.rows }));
      ws.sent.length = 0;
      h.FIT.cols = 70;
      act(() => ws.control({ type: 'replay', data: '<caught up>', cols: 90, rows: 20 }));
      act(() => void vi.advanceTimersByTime(1000));
      expect([term.cols, term.rows]).toEqual([70, h.FIT.rows]);
      expect(ws.sent).toEqual([{ type: 'resize', cols: 70, rows: h.FIT.rows }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the corner shows when a keystroke's echo was on screen — its first frame, not the spinner's after it — and the debug log gets it", () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
    try {
      const { ws, term } = mount();
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
      act(() => term.type('a'));
      clock += 29;
      act(() => ws.binary('a')); // the echo: arrived after 29 ms
      clock += 50;
      act(() => term.renderCb?.()); // drawn 79 ms after the key
      clock += 100;
      act(() => ws.binary('spinner'));
      act(() => term.renderCb?.()); // a working Claude's spinner: not the key's
      clock += 600;
      act(() => {
        vi.advanceTimersByTime(600); // the corner's half second is up
      });
      const badge = container.querySelector('.wd-pty-latency')!;
      expect(badge.textContent).toBe('⌁ 79 ms');
      expect(badge.getAttribute('title')).toContain('its echo arrived in 29 ms');
      expect(badge.getAttribute('title')).toContain('it was on screen in 79 ms');
      act(() => {
        vi.advanceTimersByTime(10_000); // the next send to the debug log
      });
      const sent = fetchMock.mock.calls.find(([url]) => url === '/api/terminal-perf');
      expect(sent).toBeDefined();
      expect(JSON.parse(String(sent![1]!.body))).toMatchObject({ sessionId: 's1', keys: [{ arrived: 29, shown: 79 }], stalls: [] });
    } finally {
      fetchMock.mockRestore();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it('on exit prints a message; Enter restarts with a new socket, other keys are ignored', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    const sentBefore = ws.sent.length;
    act(() => ws.control({ type: 'exit', code: 1 }));
    expect(term.writes.join('')).toMatch(/session exited with code 1.*press Enter/);

    act(() => term.type('x'));
    expect(ws.sent.length).toBe(sentBefore);
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => term.type('\r'));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(ws.closed).toBe(true);
    expect(term.disposed).toBe(true);
  });

  it('on an unexpected close offers reconnect; Enter reconnects', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    act(() => ws.serverClose());
    expect(term.writes.join('')).toMatch(/connection closed.*press Enter to reconnect/);
    act(() => term.type('\r'));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('⋯ → Reconnect terminal opens a new connection — for a tab whose connection went stale without saying so (reported)', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    act(() => requestTerminalReconnect('another-session'));
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => requestTerminalReconnect('s1'));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(ws.closed).toBe(true);
    expect(term.disposed).toBe(true);
    expect(FakeWebSocket.instances[1].url).toMatch(/\/ws\/sessions\/s1\/terminal$/);
  });

  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.wd-pty-elsewhere button')];

  it('when a Claude is known to run in another terminal: explains, offers no way to start a second one, and checks again', () => {
    const { ws, term } = mount();
    act(() => ws.control({ type: 'elsewhere', lastActivity: Date.now() - 40_000, state: 'working', confirmed: true }));
    const panel = document.querySelector('.wd-pty-elsewhere')!;
    expect(panel.textContent).toContain('open in another terminal');
    expect(panel.textContent).toContain('/exit');
    expect(term.writes.join('')).not.toMatch(/reconnect/); // the server's close is expected, not an outage
    act(() => ws.serverClose());
    expect(term.writes.join('')).not.toMatch(/connection closed/);
    expect(buttons().map((b) => b.textContent)).toEqual(['Check again']);

    act(() => buttons()[0].click());
    const again = FakeWebSocket.instances.at(-1)!;
    expect(again.url).toMatch(/\/terminal$/); // never ?force=1
    expect(document.querySelector('.wd-pty-elsewhere')).not.toBeNull(); // stays up while it looks
    // The other Claude was closed: the host's screen arrives and the panel goes.
    again.serverOpen();
    act(() => again.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
    expect(document.querySelector('.wd-pty-elsewhere')).toBeNull();
  });

  it('looks again by itself every few seconds while the other Claude runs', () => {
    vi.useFakeTimers();
    try {
      const { ws } = mount();
      act(() => ws.control({ type: 'elsewhere', lastActivity: null, state: null, confirmed: true }));
      const before = FakeWebSocket.instances.length;
      act(() => {
        vi.advanceTimersByTime(ELSEWHERE_RECHECK_MS + 10);
      });
      expect(FakeWebSocket.instances.length).toBe(before + 1);
      expect(FakeWebSocket.instances.at(-1)!.url).not.toMatch(/force/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('when it is only a guess from activity, starting here needs a confirmation', async () => {
    const { ws } = mount();
    act(() => ws.control({ type: 'elsewhere', lastActivity: Date.now() - 40_000, state: 'idle' }));
    const start = buttons().find((b) => /start it here/.test(b.textContent ?? ''))!;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const count = FakeWebSocket.instances.length;
    await act(async () => start.click());
    expect(confirm).toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBe(count); // declined: nothing started

    confirm.mockReturnValueOnce(true);
    await act(async () => start.click());
    expect(FakeWebSocket.instances.at(-1)!.url).toMatch(/\/terminal\?force=1$/);
  });

  it("a start that fails says why over the pane, tries again by itself, a little later each time (the PTY host didn't answer, reported)", () => {
    vi.useFakeTimers();
    try {
      const { ws } = mount();
      ws.serverOpen();
      act(() => ws.control({ type: 'error', message: 'The PTY host is running but not answering (busy?)' }));
      act(() => ws.serverClose());
      const cover = () => container.querySelector('.wd-pty-failed');
      // Not "Starting Claude…" for ever: the reason, the countdown, a button.
      expect(container.textContent).not.toContain('Starting Claude');
      expect(cover()!.textContent).toContain("Couldn't start Claude: The PTY host is running but not answering (busy?).");
      expect(cover()!.textContent).toContain('Trying again in 3 s');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(cover()).toBeNull(); // connecting again
      // It fails again: the next wait is longer.
      const again = FakeWebSocket.instances[1];
      act(() => again.serverClose());
      expect(cover()!.textContent).toContain('the connection closed before it started');
      expect(cover()!.textContent).toContain('Trying again in 10 s');
      // Once it starts, the next failure begins from the shortest wait again.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      const third = FakeWebSocket.instances[2];
      act(() => third.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
      expect(cover()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('after the last try it waits for a click; Try now / Try again starts at once', () => {
    vi.useFakeTimers();
    try {
      mount();
      for (let i = 0; i < 5; i++) {
        const ws = FakeWebSocket.instances.at(-1)!;
        act(() => ws.serverClose());
        act(() => {
          vi.advanceTimersByTime(60_000);
        });
      }
      const tries = FakeWebSocket.instances.length;
      expect(tries).toBe(5); // the first, then four on its own
      expect(container.querySelector('.wd-pty-failed')!.textContent).toContain('Stopped trying on its own.');
      const button = [...container.querySelectorAll('.wd-pty-failed button')].find(
        (b) => b.textContent === 'Try again',
      ) as HTMLButtonElement;
      act(() => button.click());
      expect(FakeWebSocket.instances).toHaveLength(tries + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints an error control frame', () => {
    const { ws, term } = mount();
    act(() => ws.control({ type: 'error', message: 'unknown session' }));
    expect(term.writes.join('')).toContain('[unknown session]');
  });

  it('Shift+Enter sends ESC CR (newline in Claude) and swallows the key', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    let handled: boolean | undefined;
    act(() => {
      handled = term.keyHandler!(key({ key: 'Enter', shiftKey: true }));
    });
    expect(handled).toBe(false);
    expect(ws.sent.at(-1)).toEqual({ type: 'input', data: '\x1b\r' });
  });

  it('plain Enter passes through to xterm', () => {
    const { term } = mount();
    expect(term.keyHandler!(key({ key: 'Enter' }))).toBe(true);
  });

  it('Ctrl+C with a selection copies instead of interrupting', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    const sent = ws.sent.length;
    term.selection = 'copied text';
    const handled = term.keyHandler!(key({ key: 'c', ctrlKey: true }));
    expect(handled).toBe(false);
    expect(writeText).toHaveBeenCalledWith('copied text');
    expect(term.hasSelection()).toBe(false);
    expect(ws.sent.length).toBe(sent);
  });

  it("what's copied is put back together: Claude Code's wrapping, indent and padding taken out (Ctrl+C and the browser's copy)", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { term } = mount();
    // Claude's reply as drawn on an 80-column terminal, selected from just after its "● ".
    const drawn = ['A sentence that Claude Code wrapped at the edge of the screen, right before   ', '  the end.', '  - a list item'].join(
      '\n',
    );
    const whole = ['A sentence that Claude Code wrapped at the edge of the screen, right before the end.', '- a list item'].join('\n');
    term.selection = drawn;
    term.selectionStart = { x: 2, y: 0 };
    term.cols = 80;
    term.keyHandler!(key({ key: 'c', ctrlKey: true }));
    expect(writeText).toHaveBeenCalledWith(whole);
    term.selection = drawn;
    const data = new Map<string, string>();
    const ev = Object.assign(new Event('copy', { bubbles: true, cancelable: true }), {
      clipboardData: { setData: (t: string, v: string) => data.set(t, v) },
    });
    term.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(data.get('text/plain')).toBe(whole);
  });

  it('leaves Ctrl+V to the browser (it pastes; xterm would have sent ^V and swallowed the key)', () => {
    const { term } = mount();
    expect(term.keyHandler!(key({ key: 'v', ctrlKey: true }))).toBe(false);
    expect(term.keyHandler!(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(term.keyHandler!(key({ key: 'Insert', shiftKey: true }))).toBe(false);
  });

  it('a paste with no text (an image) sends ^V, so Claude reads the image itself', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
    const paste = (text: string) => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { getData: () => text } });
      term.textarea.dispatchEvent(ev);
      return ev;
    };
    expect(paste('hello').defaultPrevented).toBe(false); // text: xterm's own paste handles it
    const image = paste('');
    expect(image.defaultPrevented).toBe(true);
    expect(ws.sent).toContainEqual({ type: 'input', data: '\x16' });
  });

  it('resends its size when focused, even unchanged (another window may have resized the PTY)', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
    const resizes = () => ws.sent.filter((m) => (m as { type: string }).type === 'resize').length;
    const before = resizes();
    act(() => {
      term.textarea.dispatchEvent(new Event('focus'));
    });
    expect(resizes()).toBe(before + 1);
  });

  it("opens Claude's terminal hyperlinks at their real address, web links only", () => {
    const { term } = mount();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const handler = (term.opts as { linkHandler: { activate: (e: MouseEvent, uri: string) => void } }).linkHandler;
    handler.activate(new MouseEvent('click'), 'https://github.com/o/r/pull/1');
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/1', '_blank', 'noopener');
    open.mockClear();
    openLink('file:///C:/Windows/System32/calc.exe');
    openLink('javascript:alert(1)');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('Ctrl+C without a selection passes through as an interrupt', () => {
    const { term } = mount();
    expect(term.keyHandler!(key({ key: 'c', ctrlKey: true }))).toBe(true);
  });

  it('ignores keyup events', () => {
    const { term } = mount();
    const up = new KeyboardEvent('keyup', { key: 'Enter', shiftKey: true });
    expect(term.keyHandler!(up)).toBe(true);
  });

  it('turns on Unicode 11 widths', () => {
    const { term } = mount();
    expect(term.unicode.activeVersion).toBe('11');
  });

  it('still mounts when the WebGL renderer is unavailable', () => {
    h.setWebglThrows(true);
    const { ws, term } = mount();
    expect(term).toBeDefined();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
    expect(term.writes).toContain('x');
  });

  it('without WebGL says so in the corner: drawn by the DOM renderer, the slow one', () => {
    h.setWebglThrows(true);
    mount();
    const badge = container.querySelector('.wd-pty-latency')!;
    expect(badge.textContent).toBe('DOM');
    expect(badge.className).toContain('wd-pty-latency-slow');
    expect(badge.getAttribute('title')).toContain('without the GPU');
  });

  it('a lost WebGL context is tried again after a pause (not left on the DOM renderer until a reload)', () => {
    vi.useFakeTimers();
    try {
      mount();
      expect(container.querySelector('.wd-pty-latency')).toBeNull();
      const first = h.webgls[0];
      act(() => first.loseContext());
      expect(first.disposed).toBe(true);
      expect(container.querySelector('.wd-pty-latency')!.textContent).toBe('DOM');
      act(() => void vi.advanceTimersByTime(WEBGL_RETRY_MS[0]));
      expect(h.webgls).toHaveLength(2);
      expect(container.querySelector('.wd-pty-latency')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a try again that fails (the GPU still resetting) waits and tries once more; it gives up at the fourth loss and says so', () => {
    vi.useFakeTimers();
    try {
      mount();
      const badgeTitle = () => container.querySelector('.wd-pty-latency')!.getAttribute('title')!;
      act(() => h.webgls[0].loseContext());
      expect(badgeTitle()).toContain('tried again by itself');
      h.setWebglThrows(true);
      act(() => void vi.advanceTimersByTime(WEBGL_RETRY_MS[0]));
      expect(h.webgls).toHaveLength(1);
      h.setWebglThrows(false);
      act(() => void vi.advanceTimersByTime(WEBGL_RETRY_MS[1]));
      expect(h.webgls).toHaveLength(2);
      expect(container.querySelector('.wd-pty-latency')).toBeNull();
      // Lost again (third), retried after the last pause, lost a fourth time: DOM for good.
      act(() => h.webgls[1].loseContext());
      act(() => void vi.advanceTimersByTime(WEBGL_RETRY_MS[2]));
      expect(h.webgls).toHaveLength(3);
      act(() => h.webgls[2].loseContext());
      act(() => void vi.advanceTimersByTime(10 * 60_000));
      expect(h.webgls).toHaveLength(3);
      expect(badgeTitle()).toContain('reloading the page');
      expect(badgeTitle()).not.toContain('tried again by itself');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refits after the renderer changes (the two measure a cell differently)', () => {
    vi.useFakeTimers();
    try {
      const { ws, term } = mount();
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: '', cols: 10, rows: 5 }));
      ws.sent.length = 0;
      // The DOM renderer's cells are a little wider: one column fewer fits.
      h.FIT.cols = 99;
      act(() => h.webgls[0].loseContext());
      act(() => void vi.advanceTimersByTime(0));
      expect(term.cols).toBe(99);
      expect(ws.sent).toContainEqual({ type: 'resize', cols: 99, rows: h.FIT.rows });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a retry pending at unmount never loads WebGL into the disposed terminal', () => {
    vi.useFakeTimers();
    try {
      mount();
      act(() => h.webgls[0].loseContext());
      act(() => root.render(createElement('div')));
      act(() => void vi.advanceTimersByTime(WEBGL_RETRY_MS[0]));
      expect(h.webgls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on a software rasterizer it never loads WebGL, and the corner says DOM', () => {
    h.gate.refusal = 'software';
    mount();
    expect(h.webgls).toHaveLength(0);
    expect(container.querySelector('.wd-pty-latency')!.textContent).toBe('DOM');
  });

  it('hidden in the deck it lets its WebGL context go after a while, and gets a new one when shown, before the fit', () => {
    vi.useFakeTimers();
    try {
      const { ws, term } = mount();
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: '', cols: 10, rows: 5 }));
      act(() => root.render(createElement(PtyView, { sessionId: 's1', active: false })));
      act(() => void vi.advanceTimersByTime(WEBGL_RELEASE_MS));
      expect(h.webgls[0].disposed).toBe(true);
      expect(container.querySelector('.wd-pty-latency')).toBeNull(); // not a lost context: nothing to say
      ws.sent.length = 0;
      act(() => root.render(createElement(PtyView, { sessionId: 's1', active: true })));
      expect(h.webgls).toHaveLength(2);
      expect(h.webgls[1].disposed).toBe(false);
      expect(ws.sent).toContainEqual({ type: 'resize', cols: term.cols, rows: term.rows });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a quick flip away and back keeps its WebGL context', () => {
    vi.useFakeTimers();
    try {
      mount();
      act(() => root.render(createElement(PtyView, { sessionId: 's1', active: false })));
      act(() => void vi.advanceTimersByTime(WEBGL_RELEASE_MS - 1));
      act(() => root.render(createElement(PtyView, { sessionId: 's1', active: true })));
      act(() => void vi.advanceTimersByTime(WEBGL_RELEASE_MS));
      expect(h.webgls).toHaveLength(1);
      expect(h.webgls[0].disposed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unmounted, it lets its WebGL context go with it', () => {
    mount();
    act(() => root.render(createElement('div')));
    expect(h.webgls[0].disposed).toBe(true);
  });

  it('a web font of its stack arriving after the open: measured again, atlas cleared, fitted', () => {
    const listeners: Array<(e: Event) => void> = [];
    const fonts = {
      ready: new Promise(() => {}),
      [Symbol.iterator]: () => [][Symbol.iterator](),
      addEventListener: (_t: string, fn: (e: Event) => void) => listeners.push(fn),
      removeEventListener: () => {},
    };
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    vi.useFakeTimers();
    try {
      const { ws, term } = mount();
      const family = '"Cascadia Code", monospace';
      let current: unknown = family;
      Object.defineProperty(term.options, 'fontFamily', {
        get: () => current,
        set: (v) => {
          current = v;
          term.fontFamilies.push(v);
        },
      });
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: '', cols: 10, rows: 5 }));
      ws.sent.length = 0;
      h.FIT.cols = 96; // the real font is narrower than the fallback was
      const done = (family: string) => Object.assign(new Event('loadingdone'), { fontfaces: [{ family }] });
      act(() => listeners.forEach((fn) => fn(done('Inter'))));
      act(() => void vi.advanceTimersByTime(FONT_SETTLE_MS));
      expect(term.atlasCleared).toBe(0);
      act(() => listeners.forEach((fn) => fn(done('Cascadia Code'))));
      act(() => void vi.advanceTimersByTime(FONT_SETTLE_MS));
      expect(term.fontFamilies).toEqual(['monospace', family]);
      expect(term.atlasCleared).toBe(1);
      act(() => void vi.advanceTimersByTime(FIT_MIN_MS));
      expect(ws.sent).toContainEqual({ type: 'resize', cols: 96, rows: h.FIT.rows });
    } finally {
      vi.useRealTimers();
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it('says what it is waiting for until the first screen: connecting, then starting Claude', () => {
    vi.useFakeTimers();
    try {
      const { ws } = mount();
      const overlay = () => container.querySelector('.wd-pty-connecting')?.textContent ?? null;
      expect(overlay()).toBe('Connecting…');
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(overlay()).toMatch(/Starting Claude/);
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
      expect(overlay()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('while hidden (active=false) stays connected but never resizes the shared PTY; refits and focuses when shown', () => {
    const render = (active: boolean) => act(() => root.render(createElement(PtyView, { sessionId: 's1', active })));
    render(true);
    const ws = FakeWebSocket.instances.at(-1)!;
    const term = h.terms.at(-1)!;
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
    const resizes = () => ws.sent.filter((m) => (m as { type: string }).type === 'resize');
    expect(resizes()).toHaveLength(1);

    render(false);
    h.FIT.cols = 60;
    h.FIT.rows = 20;
    vi.useFakeTimers();
    try {
      const grid = [term.cols, term.rows];
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      act(() => void vi.advanceTimersByTime(1000));
      expect(resizes()).toHaveLength(1);
      expect([term.cols, term.rows]).toEqual(grid); // its own grid kept too
      expect(ws.closed).toBe(false);

      const focused = term.focused;
      render(true);
      expect(resizes().at(-1)).toEqual({ type: 'resize', cols: 60, rows: 20 });
      expect([term.cols, term.rows]).toEqual([60, 20]);
      expect(term.focused).toBeGreaterThan(focused);
      expect(FakeWebSocket.instances.at(-1)).toBe(ws);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the socket and disposes xterm on unmount', () => {
    const { ws, term } = mount();
    act(() => root.render(createElement('div')));
    expect(ws.closed).toBe(true);
    expect(term.disposed).toBe(true);
  });
});

describe('PtyView: resizing and attaching at a size', () => {
  const resizesSent = (ws: FakeWebSocket) => ws.sent.filter((m) => (m as { type: string }).type === 'resize');
  const windowResize = () =>
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mounted, shown, its first screen drawn at the pane's grid; nothing sent or resized yet as far as the test knows. */
  function attached() {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: h.FIT.cols, rows: h.FIT.rows }));
    ws.sent.length = 0;
    term.resizes.length = 0;
    return { ws, term };
  }

  it('attaches at the pane grid when shown (the host draws its first screen for it), and states none when hidden', () => {
    const { term } = mount();
    expect(h.socketOpts.at(-1)?.grid).toEqual({ cols: h.FIT.cols, rows: h.FIT.rows });
    expect(term.resizes).toEqual([[h.FIT.cols, h.FIT.rows]]); // its own grid set to match, before anything is drawn
    act(() => root.render(createElement('div')));
    act(() => root.render(createElement(PtyView, { sessionId: 's2', active: false })));
    expect(h.socketOpts.at(-1)?.grid).toBeNull();
    expect(h.terms.at(-1)!.resizes).toEqual([]);
  });

  it('a drag (a burst of resizes) fits once at once and once at its end, the local grid and the PTY changed together', () => {
    const { ws, term } = attached();
    h.FIT.cols = 90;
    windowResize();
    expect(resizesSent(ws)).toEqual([]); // never inside the event: in a task of its own
    advance(0);
    expect(resizesSent(ws)).toEqual([{ type: 'resize', cols: 90, rows: h.FIT.rows }]);
    for (let cols = 89; cols > 80; cols--) {
      advance(4);
      h.FIT.cols = cols;
      windowResize();
    }
    expect(resizesSent(ws)).toHaveLength(1); // the rest of the burst waits for the window to end
    advance(FIT_MIN_MS);
    expect(resizesSent(ws)).toEqual([
      { type: 'resize', cols: 90, rows: h.FIT.rows },
      { type: 'resize', cols: 81, rows: h.FIT.rows }, // the last size, measured when it runs
    ]);
    // Every local resize was the PTY's too, and no other.
    expect(term.resizes).toEqual(resizesSent(ws).map((m) => [(m as { cols: number }).cols, (m as { rows: number }).rows]));
    advance(10 * FIT_MIN_MS);
    expect(resizesSent(ws)).toHaveLength(2);
  });

  it('a pane with no size (0 × 0, not laid out) changes nothing, and the grid follows once it has one', () => {
    const { ws, term } = attached();
    h.PANE.width = 0;
    h.PANE.height = 0;
    windowResize();
    advance(FIT_MIN_MS);
    act(() => {
      term.textarea.dispatchEvent(new Event('focus'));
    });
    expect(ws.sent).toEqual([]);
    expect(term.resizes).toEqual([]);
    h.PANE.width = 800;
    h.PANE.height = 600;
    h.FIT.rows = 25;
    windowResize();
    advance(FIT_MIN_MS);
    expect(resizesSent(ws)).toEqual([{ type: 'resize', cols: h.FIT.cols, rows: 25 }]);
    expect(term.resizes).toEqual([[h.FIT.cols, 25]]);
  });

  it('a pane too small to be a grid (FitAddon proposes 2 × 1) changes nothing', () => {
    const { ws, term } = attached();
    h.FIT.cols = 2;
    h.FIT.rows = 1;
    windowResize();
    advance(FIT_MIN_MS);
    expect(ws.sent).toEqual([]);
    expect(term.resizes).toEqual([]);
  });

  it('attached while not laid out: no grid stated, no size sent after the screen; the first real size is', () => {
    h.PANE.width = 0;
    const { ws, term } = mount();
    expect(h.socketOpts.at(-1)?.grid).toBeNull();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: 80, rows: 24 }));
    expect(resizesSent(ws)).toEqual([]);
    h.PANE.width = 800;
    windowResize();
    advance(0);
    expect(resizesSent(ws)).toEqual([{ type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows }]);
    expect([term.cols, term.rows]).toEqual([h.FIT.cols, h.FIT.rows]);
  });

  it('a hidden deck terminal never resizes the PTY: not after its screen, not on a resize, not on focus', () => {
    act(() => root.render(createElement(PtyView, { sessionId: 's1', active: false })));
    const ws = FakeWebSocket.instances.at(-1)!;
    const term = h.terms.at(-1)!;
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: 120, rows: 40 }));
    h.FIT.cols = 70;
    windowResize();
    advance(10 * FIT_MIN_MS);
    act(() => {
      term.textarea.dispatchEvent(new Event('focus'));
    });
    expect(ws.sent).toEqual([]);
    expect(term.resizes).toEqual([[120, 40]]); // the screen's grid, kept
  });

  it('keeps the view where you scrolled up to across a fit (the top line follows the reflow)', () => {
    const { term } = attached();
    Object.assign(term.buffer.active, { baseY: 100, viewportY: 40, cursorY: 10 });
    term.reflowShift = 15;
    h.FIT.cols = 60;
    windowResize();
    advance(0);
    expect(term.scrolledTo).toEqual([55]);
    expect(term.buffer.active.viewportY).toBe(55);
    expect(term.markers.every((m) => m.isDisposed)).toBe(true);
  });

  it('stays at the bottom across a fit when the view was there', () => {
    const { term } = attached();
    Object.assign(term.buffer.active, { baseY: 100, viewportY: 100, cursorY: 10 });
    term.reflowShift = -20;
    h.FIT.cols = 140;
    windowResize();
    advance(0);
    expect(term.scrolledTo).toEqual(['bottom']);
    expect(term.markers).toEqual([]);
  });

  it('asks the agent to repaint (redraw) after the screen of a ⋯ → Reconnect terminal only, before held input', () => {
    const { ws } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: h.FIT.cols, rows: h.FIT.rows }));
    expect(ws.sent).not.toContainEqual({ type: 'redraw' });

    act(() => requestTerminalReconnect('s1'));
    const again = FakeWebSocket.instances.at(-1)!;
    const term = h.terms.at(-1)!;
    again.serverOpen();
    act(() => term.type('q'));
    act(() => again.control({ type: 'replay', data: 'x', cols: h.FIT.cols, rows: h.FIT.rows }));
    expect(again.sent).toEqual([{ type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows }, { type: 'redraw' }, { type: 'input', data: 'q' }]);
    // Once: a later connection of the same tab (a closed one reconnected with Enter) asks for none.
    act(() => again.serverClose());
    act(() => h.terms.at(-1)!.type('\r'));
    const third = FakeWebSocket.instances.at(-1)!;
    expect(third).not.toBe(again);
    third.serverOpen();
    act(() => third.control({ type: 'replay', data: 'x', cols: h.FIT.cols, rows: h.FIT.rows }));
    expect(third.sent).not.toContainEqual({ type: 'redraw' });
  });

  it("takes ConPTY's windowsPty from a Windows host's screen, so xterm.js leaves the reflow to ConPTY", () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0, windowsPty: { backend: 'conpty', buildNumber: 22631 } }));
    expect(term.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 22631 });
  });

  it('sets no windowsPty from a host off Windows, or from a malformed one', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0, windowsPty: { backend: 'winpty', buildNumber: 'x' } }));
    expect(term.options.windowsPty).toBeUndefined();
  });
});

describe('PtyView: the view through an agent repainting its transcript (CSI 2 J, CSI 3 J, every line again)', () => {
  const BSU = (): [string, number[], string] => ['h', [2026], '?'];
  const ESU = (): [string, number[], string] => ['l', [2026], '?'];
  /** Shell output above the agent's transcript, then `n` transcript lines. */
  const transcript = (n: number, shell = 0) => [
    ...Array.from({ length: shell }, (_, i) => `$ shell ${i}`),
    ...Array.from({ length: n }, (_, i) => `line ${i}`),
  ];
  const started = () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: 0, rows: 0 }));
    term.scrolledTo.length = 0;
    return { ws, term };
  };
  /** What xterm.js does with the repaint: the scrollback cleared and refilled, a view that was scrolled up put at line 0. */
  const repaint = (term: ReturnType<typeof mount>['term'], lines: string[], wasAtBottom: boolean) => {
    term.csi('J', [2]);
    term.csi('J', [3]);
    term.setLines(lines, wasAtBottom ? 'bottom' : 0);
  };

  it('scrolled up: the text you were reading stays at the top of the view (xterm puts the view at the top of the new scrollback)', () => {
    const { term } = started();
    term.setLines(transcript(90, 10), 40); // "line 30" at the top of the view
    term.csi(...BSU());
    repaint(term, transcript(95), false); // the shell lines gone, five new lines at the end
    expect(term.scrolledTo).toEqual([]); // nothing until the frame is all there
    term.csi(...ESU());
    expect(term.scrolledTo).toEqual([30]);
    expect(term.buffer.active.getLine(30)?.translateToString(true)).toBe('line 30');
  });

  it('scrolled up, the text no longer in the reprint: the same distance from the bottom', () => {
    const { term } = started();
    term.setLines(transcript(100), 40);
    const fromBottom = term.buffer.active.baseY - 40;
    term.csi(...BSU());
    repaint(
      term,
      Array.from({ length: 120 }, (_, i) => `other ${i}`),
      false,
    );
    term.csi(...ESU());
    expect(term.scrolledTo).toEqual([term.buffer.active.baseY - fromBottom]);
  });

  it('at the bottom: stays at the bottom', () => {
    const { term } = started();
    term.setLines(transcript(100), 'bottom');
    term.csi(...BSU());
    repaint(term, transcript(105), true);
    term.csi(...ESU());
    expect(term.scrolledTo).toEqual(['bottom']);
  });

  it('a repaint with no synchronized frame around it is put right once the write it arrived in is parsed', () => {
    const { ws, term } = started();
    term.setLines(transcript(90, 10), 40);
    term.deferWrites = true;
    act(() => ws.binary('the repaint'));
    repaint(term, transcript(95), false); // xterm parsing that write
    expect(term.scrolledTo).toEqual([]);
    act(() => term.parsed());
    expect(term.scrolledTo).toEqual([30]);
  });

  it('a cleared screen alone (CSI 2 J, the scrollback kept), the alternate screen and a reset (RIS) move nothing', () => {
    const { ws, term } = started();
    term.setLines(transcript(100), 40);
    term.csi(...BSU());
    term.csi('J', [2]);
    term.csi(...ESU());
    term.buffer.active.type = 'alternate';
    term.csi(...BSU());
    term.csi('J', [3]);
    term.csi(...ESU());
    term.buffer.active.type = 'normal';
    term.csi(...BSU());
    term.csi('J', [3]);
    term.esc('c'); // a catch-up's reset: the frame and what it noted are gone
    act(() => ws.binary('x'));
    expect(term.scrolledTo).toEqual([]);
  });

  it('lets xterm handle every sequence itself, and drops its hooks with the terminal', () => {
    const { term } = started();
    expect(term.hooks).toBeGreaterThan(0);
    expect([term.csi('J', [3]), term.csi('h', [2026], '?'), term.csi('l', [2026], '?'), term.esc('c')]).toEqual([true, true, true, true]);
    act(() => root.unmount());
    root = createRoot(container);
    expect(term.hooks).toBe(0);
  });
});

describe('PtyView: the terminal engine switch', () => {
  afterEach(() => {
    localStorage.removeItem('work.terminalEngine');
    window.history.replaceState(null, '', '/');
  });

  it('xterm.js by default, at once (no wait for the setting)', () => {
    const { term } = mount();
    expect(term).toBeDefined();
    expect(h.terms).toHaveLength(1);
  });

  it('?terminalEngine=ghostty that cannot be loaded falls back to xterm.js, and the corner says so', async () => {
    window.history.replaceState(null, '', '/?terminalEngine=ghostty');
    act(() => {
      root.render(createElement(PtyView, { sessionId: 's1' }));
    });
    expect(h.terms).toHaveLength(0);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.terms).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const badge = container.querySelector('.wd-pty-latency')!;
    expect(badge.textContent).toContain('xterm.js');
    expect(badge.getAttribute('title')).toContain('libghostty-vt could not be loaded (no module)');
  });
});

describe('PtyView: reconnecting where it left off (terminal-rendering.md, "Reattach where you left off")', () => {
  const S = 'abcdef0123456789';
  /** `text` as the UTF-8 bytes the host sends, one char per byte (FakeWebSocket.binary sends char codes as bytes). */
  const utf8 = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));
  const overlay = () => container.querySelector('.wd-pty-connecting')?.textContent ?? null;
  const acks = (ws: FakeWebSocket) => ws.sent.filter((m) => (m as { type: string }).type === 'ack');
  /** A tab drawn from a current host's screen (at the pane's grid, so nothing is resized), then output, then the drop. */
  function connectedThenDropped(output: string[] = []) {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '<screen>', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1000 }));
    for (const o of output) act(() => ws.binary(o));
    const written = term.writes.length;
    act(() => ws.serverClose());
    return { ws, term, written };
  }
  const next = () => FakeWebSocket.instances.at(-1)!;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a dropped connection is reconnected in place, from where it stands: the replay’s offset plus each frame, counted as the host counts', () => {
    const { term, written } = connectedThenDropped([utf8('aé😀'), utf8('bc')]); // 1 + 1 + 2, then 2
    expect(term.writes.length).toBe(written); // nothing written on the screen it kept
    act(() => void vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(h.terms).toHaveLength(1);
    expect(term.disposed).toBe(false);
    expect(h.socketOpts.at(-1)).toMatchObject({
      force: false,
      grid: { cols: h.FIT.cols, rows: h.FIT.rows },
      resume: { stream: S, offset: 1006, cols: h.FIT.cols, rows: h.FIT.rows },
    });
  });

  it('sent what it missed: drawn on the screen it kept (no reset, no resize; scroll position and selection stay), then input', () => {
    const { term, written } = connectedThenDropped(['abc']);
    term.selection = 'picked';
    term.buffer.active.viewportY = 3;
    const resizes = term.resizes.length;
    act(() => term.type('typed'));
    act(() => void vi.advanceTimersByTime(0));
    const again = next();
    expect(again.sent).toEqual([]);
    again.serverOpen();
    act(() =>
      again.control({ type: 'replay', data: 'missed', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1009, resumed: true }),
    );
    const drawn = term.writes.slice(written);
    expect(drawn.join('')).toBe('missed');
    expect(drawn.join('')).not.toContain('\x1bc');
    expect(term.resizes.length).toBe(resizes);
    expect(term.selection).toBe('picked');
    expect(term.buffer.active.viewportY).toBe(3);
    expect(term.writes.join('')).not.toMatch(/connection closed/);
    expect(again.sent).toEqual([
      { type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows },
      { type: 'input', data: 'typed' },
    ]);
    expect(overlay()).toBeNull();
  });

  it('what it missed, sent mid-session (it fell behind and was caught up from the host’s tail), is drawn on the screen it has: scrollback, scroll position and selection kept', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '<screen>', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1000 }));
    act(() => ws.binary('seen'));
    term.selection = 'picked';
    term.buffer.active.viewportY = 3;
    const resizes = term.resizes.length;
    const written = term.writes.length;
    const sent = [...ws.sent];
    act(() => ws.control({ type: 'replay', data: 'missed', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1010, resumed: true }));
    act(() => void vi.advanceTimersByTime(1000));
    const drawn = term.writes.slice(written).join('');
    expect(drawn).toBe('missed'); // no reset (RIS would clear the scrollback)
    expect(term.resizes.length).toBe(resizes);
    expect(term.selection).toBe('picked');
    expect(term.buffer.active.viewportY).toBe(3);
    expect(ws.sent).toEqual(sent); // no size, no ack for it
    // It stands at that replay's offset now, moved on by what follows.
    act(() => ws.binary('ab'));
    act(() => ws.serverClose());
    act(() => void vi.advanceTimersByTime(0));
    expect(h.socketOpts.at(-1)?.resume).toMatchObject({ stream: S, offset: 1012 });
  });

  it('a screen instead (the host could not tell that would be enough): drawn over a reset terminal, at its grid', () => {
    const { term, written } = connectedThenDropped(['abc']);
    act(() => void vi.advanceTimersByTime(0));
    const again = next();
    again.serverOpen();
    act(() => again.control({ type: 'replay', data: '<new screen>', cols: 90, rows: 20, stream: 'ffffffffffffffff', offset: 7 }));
    expect(term.writes.slice(written).join('')).toBe('\x1bc<new screen>');
    expect(term.resizes).toContainEqual([90, 20]);
    // …and it stands where that screen says.
    act(() => again.serverClose());
    act(() => void vi.advanceTimersByTime(0));
    expect(h.socketOpts.at(-1)?.resume).toMatchObject({ stream: 'ffffffffffffffff', offset: 7 });
  });

  it('what xterm answers while it draws what it missed is dropped (those queries were answered when they came); typing is kept', () => {
    const { term } = connectedThenDropped();
    act(() => void vi.advanceTimersByTime(0));
    const again = next();
    again.serverOpen();
    term.deferWrites = true;
    act(() =>
      again.control({ type: 'replay', data: '\x1b[c', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1003, resumed: true }),
    );
    act(() => term.parseOne()); // the mark before it
    act(() => term.type('\x1b[?1;2c')); // xterm's answer, as it parses the query
    act(() => term.type('q'));
    act(() => term.type('\x1b[I')); // a focus report is no answer
    act(() => term.parseOne()); // the missed output parsed: done
    expect(again.sent).toEqual([
      { type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows },
      { type: 'input', data: 'q' },
      { type: 'input', data: '\x1b[I' },
    ]);
    // Live output's queries are answered again.
    term.deferWrites = false;
    act(() => again.binary('\x1b[c'));
    act(() => term.type('\x1b[?1;2c'));
    expect(again.sent.at(-1)).toEqual({ type: 'input', data: '\x1b[?1;2c' });
  });

  it('acks restart on the new connection: what it missed is not acked, and nothing owed on the old one is paid on it', () => {
    const { ws } = connectedThenDropped(['a'.repeat(ACK_EVERY - 1)]);
    expect(acks(ws)).toEqual([]);
    act(() => void vi.advanceTimersByTime(0));
    const again = next();
    again.serverOpen();
    act(() =>
      again.control({
        type: 'replay',
        data: 'm'.repeat(ACK_EVERY),
        cols: h.FIT.cols,
        rows: h.FIT.rows,
        stream: S,
        offset: 9000,
        resumed: true,
      }),
    );
    act(() => again.binary('b'));
    expect(acks(again)).toEqual([]);
    act(() => again.binary('b'.repeat(ACK_EVERY - 1)));
    expect(acks(again)).toEqual([{ type: 'ack', chars: ACK_EVERY }]);
  });

  it('a catch-up screen mid-session (it fell behind) moves where it stands', () => {
    const { ws } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 10 }));
    act(() => ws.binary('abc'));
    act(() => ws.control({ type: 'replay', data: 'screen', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 5000 }));
    act(() => ws.binary('de'));
    act(() => ws.serverClose());
    act(() => void vi.advanceTimersByTime(0));
    expect(h.socketOpts.at(-1)?.resume).toMatchObject({ stream: S, offset: 5002 });
  });

  it('says "Connecting…" only if it takes RECONNECT_COVER_MS', () => {
    connectedThenDropped();
    act(() => void vi.advanceTimersByTime(RECONNECT_COVER_MS - 1));
    expect(overlay()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(overlay()).toBe('Connecting…');
    const again = next();
    again.serverOpen();
    act(() => again.control({ type: 'replay', data: '', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1000, resumed: true }));
    expect(overlay()).toBeNull();
  });

  it('tries again after each delay; when none gets through, says so as before, and Enter starts over', () => {
    const { term } = connectedThenDropped();
    for (const delay of RECONNECT_DELAYS_MS) {
      act(() => void vi.advanceTimersByTime(delay));
      const attempt = next();
      act(() => attempt.control({ type: 'error', message: 'its terminal is not running' }));
      act(() => attempt.serverClose());
    }
    expect(FakeWebSocket.instances).toHaveLength(1 + RECONNECT_DELAYS_MS.length);
    // A try's error isn't written on the screen it kept: the last one's is said once, in the closing message.
    expect(term.writes.join('').match(/not running/g)).toHaveLength(1);
    expect(term.writes.join('')).toMatch(/connection closed: its terminal is not running — press Enter to reconnect/);
    expect(term.writes.join('')).not.toMatch(/not sent/); // nothing was typed
    expect(overlay()).toBeNull();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1 + RECONNECT_DELAYS_MS.length);
    act(() => term.type('\r'));
    expect(h.socketOpts.at(-1)?.resume).toBeNull();
    expect(h.terms).toHaveLength(2);
  });

  it('a drop while what it missed is still being drawn: nothing made ready by it, and the next replay is drawn as missed output too', () => {
    const { term, written } = connectedThenDropped(['abc']); // stands at 1003
    act(() => void vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]));
    const first = next();
    first.serverOpen();
    term.deferWrites = true;
    act(() =>
      first.control({ type: 'replay', data: 'missed', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1009, resumed: true }),
    );
    act(() => first.binary('xy')); // live output after it, given to xterm too
    act(() => term.type('typed'));
    act(() => first.serverClose()); // it drops before xterm drew any of it…
    act(() => term.parsed()); // …which it draws now: on the screen it kept, in order, and nothing is sent on a closed connection
    expect(first.sent).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(2); // the next try waits for its delay
    term.deferWrites = false;
    act(() => void vi.advanceTimersByTime(RECONNECT_DELAYS_MS[1]));
    // It states what it was given, in order: the replay's offset and the frame after it.
    expect(h.socketOpts.at(-1)?.resume).toMatchObject({ stream: S, offset: 1011 });
    const second = next();
    second.serverOpen();
    act(() => second.control({ type: 'replay', data: 'more', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 1015, resumed: true }));
    const drawn = term.writes.slice(written).join('');
    expect(drawn).toBe('missedxymore');
    expect(drawn).not.toContain('\x1bc'); // never over a reset terminal: the screen and scrollback stay
    expect(second.sent).toEqual([
      { type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows },
      { type: 'input', data: 'typed' },
    ]);
    expect(overlay()).toBeNull();
  });

  it('a screen drawn for a connection that dropped before it was drawn: the next connection still resumes from it', () => {
    const { term, written } = connectedThenDropped();
    act(() => void vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]));
    const first = next();
    first.serverOpen();
    term.deferWrites = true;
    act(() => first.control({ type: 'replay', data: '<screen>', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 2000 }));
    act(() => first.serverClose());
    act(() => term.parsed());
    term.deferWrites = false;
    act(() => void vi.advanceTimersByTime(RECONNECT_DELAYS_MS[1]));
    expect(h.socketOpts.at(-1)?.resume).toMatchObject({ stream: S, offset: 2000 });
    const second = next();
    second.serverOpen();
    act(() => second.control({ type: 'replay', data: 'm', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 2001, resumed: true }));
    expect(term.writes.slice(written).join('')).toBe('\x1bc<screen>m');
    expect(second.sent).toEqual([{ type: 'resize', cols: h.FIT.cols, rows: h.FIT.rows }]);
  });

  it('when the tries run out it says the host’s reason, and that what was typed meanwhile was not sent', () => {
    const { term } = connectedThenDropped();
    act(() => term.type('lost keys'));
    for (const delay of RECONNECT_DELAYS_MS) {
      act(() => void vi.advanceTimersByTime(delay));
      act(() => next().control({ type: 'error', message: 'no such pty' }));
      act(() => next().serverClose());
    }
    expect(term.writes.join('')).toMatch(
      /connection closed: no such pty; what you typed meanwhile was not sent — press Enter to reconnect/,
    );
  });

  it('a catch-up the host could take no screen for (it says no stream): nothing drawn over the screen, and it no longer resumes', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '<screen>', cols: h.FIT.cols, rows: h.FIT.rows, stream: S, offset: 10 }));
    const written = term.writes.length;
    act(() => ws.control({ type: 'replay', data: '', cols: h.FIT.cols, rows: h.FIT.rows, stream: '', offset: 500, resumed: true }));
    expect(term.writes.slice(written).join('')).toBe('');
    act(() => ws.binary('live'));
    expect(term.writes.slice(written).join('')).toBe('live');
    act(() => ws.serverClose());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(FakeWebSocket.instances).toHaveLength(1); // where it stands is unknown: no reconnect in place
    expect(term.writes.join('')).toMatch(/connection closed — press Enter to reconnect/);
  });

  it('a host from before (its replay says no stream): no reconnect in place, the old message at once', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: '', cols: h.FIT.cols, rows: h.FIT.rows }));
    act(() => ws.binary('output'));
    act(() => ws.serverClose());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(term.writes.join('')).toMatch(/connection closed.*press Enter to reconnect/);
  });
});
