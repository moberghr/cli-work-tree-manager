// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// ---- xterm fakes -----------------------------------------------------------

const h = vi.hoisted(() => {
  const FIT = { cols: 100, rows: 30 };
  const terms: FakeTerminal[] = [];
  let webglThrows = false;

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
    }
    write(data: string | Uint8Array, cb?: () => void) {
      this.writes.push(typeof data === 'string' ? data : String.fromCharCode(...data));
      cb?.();
    }
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
      return { dispose: () => { this.dataCb = null; } };
    }
    attachCustomKeyEventHandler(fn: KeyHandler) {
      this.keyHandler = fn;
    }
    hasSelection() { return this.selection.length > 0; }
    getSelection() { return this.selection; }
    clearSelection() { this.selection = ''; }
    dispose() { this.disposed = true; }
    /** Simulate typing (what xterm's onData emits). */
    type(d: string) { this.dataCb?.(d); }
  }

  class FakeFit {
    private t: FakeTerminal | null = null;
    activate(t: FakeTerminal) { this.t = t; }
    fit() {
      if (!this.t) return;
      this.t.cols = FIT.cols;
      this.t.rows = FIT.rows;
    }
  }

  class FakeWebgl {
    constructor() {
      if (webglThrows) throw new Error('no webgl');
    }
    onContextLoss() {}
    dispose() {}
  }

  return {
    FIT,
    terms,
    FakeTerminal,
    FakeFit,
    FakeWebgl,
    setWebglThrows: (v: boolean) => { webglThrows = v; },
  };
});

vi.mock('@xterm/xterm', () => ({ Terminal: h.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: h.FakeFit }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: h.FakeWebgl }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

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
  serverOpen() { this.readyState = 1; this.emit('open'); }
  control(frame: object) { this.emit('message', JSON.stringify(frame)); }
  binary(text: string) {
    // Build the buffer in this realm: TextEncoder's can come from jsdom's,
    // which fails PtyView's `instanceof ArrayBuffer` check.
    const buf = new ArrayBuffer(text.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i);
    this.emit('message', buf);
  }
  serverClose() { this.readyState = 3; this.emit('close'); }
}

import { ELSEWHERE_RECHECK_MS, PtyView } from '../../src/web/src/components/Terminal/PtyView.js';

let container: HTMLDivElement;
let root: Root;
const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  h.terms.length = 0;
  h.setWebglThrows(false);
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
    act(() => ws.control({ type: 'replay', data: '<screen>', cols: 120, rows: 40 }));

    expect(term.resizes.at(-1)).toEqual([120, 40]);
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
    expect(term.resizes).toEqual([]);
  });

  it('writes binary frames as PTY output', () => {
    const { ws, term } = mount();
    ws.serverOpen();
    act(() => ws.binary('hello'));
    expect(term.writes).toContain('hello');
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
    act(() => ws.serverClose());
    expect(term.writes.join('')).toMatch(/connection closed.*press Enter to reconnect/);
    act(() => term.type('\r'));
    expect(FakeWebSocket.instances).toHaveLength(2);
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
      act(() => { vi.advanceTimersByTime(ELSEWHERE_RECHECK_MS + 10); });
      expect(FakeWebSocket.instances.length).toBe(before + 1);
      expect(FakeWebSocket.instances.at(-1)!.url).not.toMatch(/force/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('when it is only a guess from activity, starting here needs a confirmation', () => {
    const { ws } = mount();
    act(() => ws.control({ type: 'elsewhere', lastActivity: Date.now() - 40_000, state: 'idle' }));
    const start = buttons().find((b) => /start it here/.test(b.textContent ?? ''))!;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const count = FakeWebSocket.instances.length;
    act(() => start.click());
    expect(confirm).toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBe(count); // declined: nothing started

    confirm.mockReturnValueOnce(true);
    act(() => start.click());
    expect(FakeWebSocket.instances.at(-1)!.url).toMatch(/\/terminal\?force=1$/);
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

  it('says what it is waiting for until the first screen: connecting, then starting Claude', () => {
    vi.useFakeTimers();
    try {
      const { ws } = mount();
      const overlay = () => container.querySelector('.wd-pty-connecting')?.textContent ?? null;
      expect(overlay()).toBe('Connecting…');
      act(() => { vi.advanceTimersByTime(800); });
      expect(overlay()).toMatch(/Starting Claude/);
      ws.serverOpen();
      act(() => ws.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
      expect(overlay()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('while hidden (active=false) stays connected but never resizes the shared PTY; refits and focuses when shown', () => {
    const render = (active: boolean) =>
      act(() => root.render(createElement(PtyView, { sessionId: 's1', active })));
    render(true);
    const ws = FakeWebSocket.instances.at(-1)!;
    const term = h.terms.at(-1)!;
    ws.serverOpen();
    act(() => ws.control({ type: 'replay', data: 'x', cols: 10, rows: 5 }));
    const resizes = () => ws.sent.filter((m) => (m as { type: string }).type === 'resize');
    expect(resizes()).toHaveLength(1);

    render(false);
    const before = { ...h.FIT };
    h.FIT.cols = 60;
    h.FIT.rows = 20;
    try {
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(resizes()).toHaveLength(1);
      expect(ws.closed).toBe(false);

      const focused = term.focused;
      render(true);
      expect(resizes().at(-1)).toEqual({ type: 'resize', cols: 60, rows: 20 });
      expect(term.focused).toBeGreaterThan(focused);
      expect(FakeWebSocket.instances.at(-1)).toBe(ws);
    } finally {
      Object.assign(h.FIT, before);
    }
  });

  it('closes the socket and disposes xterm on unmount', () => {
    const { ws, term } = mount();
    act(() => root.render(createElement('div')));
    expect(ws.closed).toBe(true);
    expect(term.disposed).toBe(true);
  });
});
