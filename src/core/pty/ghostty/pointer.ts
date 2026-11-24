import { check, type VtEngine, type VtTerminal } from './vt-terminal.js';

/**
 * What the pointer does to a terminal's screen (selection.h, grid_ref.h): libghostty's own selection gestures (a click,
 * a double click for a word, a triple for a line, a drag, the autoscroll past an edge), the terminal's selection (read,
 * extended, cleared, copied), and the OSC 8 link under a cell. Pure: the browser's ghostty engine turns pointer events
 * into these calls and draws what the render state then says is selected.
 */

/** A cell of the view: its column, and its row counted from the top of what is shown. */
export interface ViewCell {
  x: number;
  y: number;
}

/** A cell of the whole screen, scrollback included: its row counted from the oldest line kept. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** The pointer: the cell under it (clamped into the view) and where it is in surface pixels (not clamped). */
export interface PointerAt {
  cell: ViewCell;
  px: number;
  py: number;
}

/** What a drag needs to know of the drawn grid, in surface pixels. */
export interface DragGeometry {
  cols: number;
  cellWidth: number;
  paddingLeft: number;
  /** The grid's height: a pointer above 0 or below this scrolls the view while dragging. */
  height: number;
}

export type Autoscroll = 'none' | 'up' | 'down';

/** The scratch slots of a gesture's buffer: a grid ref, a selection, a position, a geometry, a coordinate, a u64. */
const SLOT = 32;
const AT = { ref: 0, sel: SLOT, pos: 2 * SLOT, geom: 3 * SLOT, coord: 4 * SLOT, u64: 5 * SLOT, ref2: 6 * SLOT } as const;
const BUF = 7 * SLOT;
const NO_VALUE = -4;
const OUT_OF_SPACE = -3;

/** The terminal option and data keys and the point tags, by name from the manifest. */
function keys(e: VtEngine) {
  const m = e.g.manifest;
  return {
    setSelection: m.value('GhosttyTerminalOption', 'SELECTION'),
    getSelection: m.value('GhosttyTerminalData', 'SELECTION'),
    viewport: m.value('GhosttyPointTag', 'VIEWPORT'),
    screen: m.value('GhosttyPointTag', 'SCREEN'),
    forward: m.value('GhosttySelectionOrder', 'FORWARD'),
  };
}

/** The handles a terminal-level call needs; null once it is freed. */
function native(t: VtTerminal) {
  const n = t.native;
  return n ? { ...n, k: keys(n.e) } : null;
}

/** The grid ref of a view cell into `into`; false when the cell is not on the screen. */
function viewRef(e: VtEngine, handle: number, viewport: number, cell: ViewCell, into: number): boolean {
  const pt = e.g.layout.point;
  e.u8().fill(0, e.point, e.point + pt.size);
  const dv = e.dv();
  dv.setUint32(e.point + pt.tag, viewport, true);
  dv.setUint16(e.point + pt.x, Math.max(0, cell.x), true);
  dv.setUint32(e.point + pt.y, Math.max(0, cell.y), true);
  return e.g.fn.ghostty_terminal_grid_ref(handle, e.point, into) === 0;
}

/** A grid ref's place on the whole screen. */
function screenPoint(e: VtEngine, handle: number, screen: number, ref: number): ScreenPoint | null {
  const m = e.g.manifest;
  const C = 'GhosttyPointCoordinate';
  if (e.g.fn.ghostty_terminal_point_from_grid_ref(handle, ref, screen, e.out) !== 0) return null;
  const dv = e.dv();
  return { x: dv.getUint16(e.out + m.offset(C, 'x'), true), y: dv.getUint32(e.out + m.offset(C, 'y'), true) };
}

const before = (a: ScreenPoint, b: ScreenPoint) => a.y < b.y || (a.y === b.y && a.x < b.x);

/** A selection gesture: one per terminal view, fed the pointer's presses, drags, releases and autoscroll ticks. */
export class SelectionGesture {
  private e: VtEngine | null;
  private readonly terminal: number;
  private readonly gesture: number;
  private readonly events: { press: number; release: number; drag: number; tick: number };
  /** What alloc returned, and the 8-aligned scratch in it. */
  private readonly raw: number;
  private readonly buf: number;
  private readonly opt: {
    ref: number;
    position: number;
    time: number;
    geometry: number;
    viewport: number;
    interval: number;
    distance: number;
  };
  private readonly data: { clicks: number; dragged: number; autoscroll: number };
  private readonly scroll: { up: number; down: number };
  private readonly k: ReturnType<typeof keys>;

  private constructor(t: VtTerminal) {
    const n = t.native;
    if (!n) throw new Error('libghostty-vt: terminal freed');
    const e = n.e;
    this.e = e;
    this.terminal = n.handle;
    this.k = keys(e);
    const { fn, manifest: m } = e.g;
    for (const s of ['GhosttyGridRef', 'GhosttySurfacePosition', 'GhosttySelectionGestureGeometry', 'GhosttyPointCoordinate']) {
      if (m.size(s) > SLOT) throw new Error(`libghostty-vt: ${s} larger than expected`);
    }
    if (e.g.layout.selection.size > SLOT) throw new Error('libghostty-vt: GhosttySelection larger than expected');
    check(fn.ghostty_selection_gesture_new(0, e.slot), 'selection_gesture_new');
    this.gesture = e.take();
    const T = 'GhosttySelectionGestureEventType';
    const event = (type: string) => {
      check(fn.ghostty_selection_gesture_event_new(0, e.slot, m.value(T, type)), `selection_gesture_event_new ${type}`);
      return e.take();
    };
    this.events = { press: event('PRESS'), release: event('RELEASE'), drag: event('DRAG'), tick: event('AUTOSCROLL_TICK') };
    this.raw = fn.ghostty_wasm_alloc(BUF + 8) >>> 0;
    if (!this.raw) throw new Error('libghostty-vt: out of memory');
    this.buf = Math.ceil(this.raw / 8) * 8;
    const O = 'GhosttySelectionGestureEventOption';
    this.opt = {
      ref: m.value(O, 'REF'),
      position: m.value(O, 'POSITION'),
      time: m.value(O, 'TIME_NS'),
      geometry: m.value(O, 'GEOMETRY'),
      viewport: m.value(O, 'VIEWPORT'),
      interval: m.value(O, 'REPEAT_INTERVAL_NS'),
      distance: m.value(O, 'REPEAT_DISTANCE'),
    };
    this.repeat(500, 8);
    const D = 'GhosttySelectionGestureData';
    this.data = { clicks: m.value(D, 'CLICK_COUNT'), dragged: m.value(D, 'DRAGGED'), autoscroll: m.value(D, 'AUTOSCROLL') };
    const A = 'GhosttySelectionGestureAutoscroll';
    this.scroll = { up: m.value(A, 'UP'), down: m.value(A, 'DOWN') };
  }

  /** A gesture for `t`'s view (freed separately, before the terminal). */
  static create(t: VtTerminal): SelectionGesture {
    return new SelectionGesture(t);
  }

  /** How close in time and space (surface pixels) a press must follow the last to count as a double or triple click. */
  repeat(ms: number, px: number): void {
    const e = this.e;
    if (!e) return;
    const ev = this.events.press;
    const at = this.buf + AT.u64;
    e.dv().setBigUint64(at, BigInt(Math.round(ms * 1e6)), true);
    check(e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.interval, at), 'gesture repeat interval');
    e.dv().setFloat64(at, px, true);
    check(e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.distance, at), 'gesture repeat distance');
  }

  /**
   * A button press at `p`, `timeMs` on a monotonic clock (so a quick second press is a double click). A double or
   * triple click selects a word or a line; a single one clears the selection (a drag then makes one).
   */
  press(p: PointerAt, timeMs: number): void {
    const e = this.e;
    if (!e) return;
    const ev = this.events.press;
    if (!this.ref(p.cell, ev)) return;
    this.position(p, ev);
    e.dv().setBigUint64(this.buf + AT.u64, BigInt(Math.max(0, Math.round(timeMs * 1e6))), true);
    check(e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.time, this.buf + AT.u64), 'gesture time');
    this.apply(ev, true);
  }

  /** The pointer moved with the button held: the selection runs from the press to here (by word or line after a double or triple click). */
  drag(p: PointerAt, g: DragGeometry): void {
    const ev = this.events.drag;
    if (!this.e || !this.ref(p.cell, ev)) return;
    this.position(p, ev);
    this.geometry(g, ev);
    this.apply(ev, false);
  }

  /** The button went up (at `p`, or off the grid). */
  release(p: PointerAt | null): void {
    const e = this.e;
    if (!e) return;
    const ev = this.events.release;
    if (!p || !this.ref(p.cell, ev)) e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.ref, 0);
    e.g.fn.ghostty_selection_gesture_event(this.gesture, this.terminal, ev, 0);
  }

  /** One autoscroll step while `autoscroll()` says to: scrolls the view a row and carries the selection on. */
  tick(p: PointerAt, g: DragGeometry): void {
    const e = this.e;
    if (!e) return;
    const ev = this.events.tick;
    const m = e.g.manifest;
    const C = 'GhosttyPointCoordinate';
    const at = this.buf + AT.coord;
    e.u8().fill(0, at, at + SLOT);
    e.dv().setUint16(at + m.offset(C, 'x'), Math.max(0, p.cell.x), true);
    e.dv().setUint32(at + m.offset(C, 'y'), Math.max(0, p.cell.y), true);
    check(e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.viewport, at), 'gesture viewport');
    this.position(p, ev);
    this.geometry(g, ev);
    this.apply(ev, false);
  }

  /** Which way a drag past the grid's top or bottom edge wants the view to scroll. */
  autoscroll(): Autoscroll {
    const v = this.get(this.data.autoscroll, 4);
    return v === this.scroll.up ? 'up' : v === this.scroll.down ? 'down' : 'none';
  }

  /** The clicks of the current press: 1, 2 (word), 3 (line). */
  clicks(): number {
    return this.get(this.data.clicks, 1);
  }

  /** Whether the pointer has moved off the pressed cell with the button held. */
  dragged(): boolean {
    return this.get(this.data.dragged, 1) !== 0;
  }

  /** Forgets the press in progress (the selection stays). */
  reset(): void {
    if (this.e) this.e.g.fn.ghostty_selection_gesture_reset(this.gesture, this.terminal);
  }

  free(): void {
    const e = this.e;
    if (!e) return;
    this.e = null;
    const { fn } = e.g;
    for (const ev of Object.values(this.events)) fn.ghostty_selection_gesture_event_free(ev);
    fn.ghostty_selection_gesture_free(this.gesture, this.terminal);
    fn.ghostty_wasm_free(this.raw, BUF + 8);
  }

  private get(key: number, bytes: 1 | 4): number {
    const e = this.e;
    if (!e) return 0;
    e.dv().setUint32(e.out, 0, true);
    if (e.g.fn.ghostty_selection_gesture_get(this.gesture, this.terminal, key, e.out) !== 0) return 0;
    return bytes === 1 ? e.dv().getUint8(e.out) : e.dv().getUint32(e.out, true);
  }

  private ref(cell: ViewCell, ev: number): boolean {
    const e = this.e!;
    if (!viewRef(e, this.terminal, this.k.viewport, cell, this.buf + AT.ref)) return false;
    check(e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.ref, this.buf + AT.ref), 'gesture ref');
    return true;
  }

  private position(p: PointerAt, ev: number): void {
    const e = this.e!;
    const m = e.g.manifest;
    const S = 'GhosttySurfacePosition';
    const at = this.buf + AT.pos;
    e.dv().setFloat64(at + m.offset(S, 'x'), p.px, true);
    e.dv().setFloat64(at + m.offset(S, 'y'), p.py, true);
    check(e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.position, at), 'gesture position');
  }

  private geometry(g: DragGeometry, ev: number): void {
    const e = this.e!;
    const m = e.g.manifest;
    const G = 'GhosttySelectionGestureGeometry';
    const at = this.buf + AT.geom;
    const dv = e.dv();
    dv.setUint32(at + m.offset(G, 'columns'), Math.max(1, g.cols), true);
    dv.setUint32(at + m.offset(G, 'cell_width'), Math.max(1, Math.round(g.cellWidth)), true);
    dv.setUint32(at + m.offset(G, 'padding_left'), Math.max(0, Math.round(g.paddingLeft)), true);
    dv.setUint32(at + m.offset(G, 'screen_height'), Math.max(1, Math.round(g.height)), true);
    check(e.g.fn.ghostty_selection_gesture_event_set(ev, this.opt.geometry, at), 'gesture geometry');
  }

  /** Runs the event: a selection it makes becomes the terminal's; a press that makes none clears the terminal's. */
  private apply(ev: number, press: boolean): void {
    const e = this.e!;
    const { fn } = e.g;
    const sel = this.buf + AT.sel;
    const r = fn.ghostty_selection_gesture_event(this.gesture, this.terminal, ev, sel);
    if (r === 0) fn.ghostty_terminal_set(this.terminal, this.k.setSelection, sel);
    else if (r === NO_VALUE && press) fn.ghostty_terminal_set(this.terminal, this.k.setSelection, 0);
  }
}

/** Whether the terminal has a selection. */
export function hasSelection(t: VtTerminal): boolean {
  const n = native(t);
  if (!n) return false;
  return n.e.g.fn.ghostty_terminal_get(n.handle, n.k.getSelection, n.e.selection) === 0;
}

/** Drops the terminal's selection. */
export function clearSelection(t: VtTerminal): void {
  const n = native(t);
  if (n) n.e.g.fn.ghostty_terminal_set(n.handle, n.k.setSelection, 0);
}

/** The selection's first and last cells (inclusive), in reading order, on the whole screen; null when there is none. */
export function selectionBounds(t: VtTerminal): { start: ScreenPoint; end: ScreenPoint } | null {
  const n = native(t);
  if (!n) return null;
  const { e, handle, k } = n;
  const { fn, layout } = e.g;
  const s = layout.selection;
  if (fn.ghostty_terminal_get(handle, k.getSelection, e.selection) !== 0) return null;
  // Ordered into the aux area: the selection and its two refs, then read back through the refs.
  if (fn.ghostty_terminal_selection_ordered(handle, e.selection, k.forward, e.aux) !== 0) return null;
  const start = screenPoint(e, handle, k.screen, e.aux + s.start);
  const end = screenPoint(e, handle, k.screen, e.aux + s.end);
  return start && end ? { start, end } : null;
}

/** Shift+click: the selection grows (or shrinks) to `cell`, from its far end; a new one from the cursor's press if there is none. */
export function extendSelection(t: VtTerminal, cell: ViewCell): boolean {
  const n = native(t);
  if (!n) return false;
  const { e, handle, k } = n;
  const { fn, layout } = e.g;
  const s = layout.selection;
  if (fn.ghostty_terminal_get(handle, k.getSelection, e.selection) !== 0) return false;
  if (fn.ghostty_terminal_selection_ordered(handle, e.selection, k.forward, e.aux) !== 0) return false;
  const clicked = e.aux + 64;
  if (!viewRef(e, handle, k.viewport, cell, clicked)) return false;
  const at = screenPoint(e, handle, k.screen, clicked);
  const start = screenPoint(e, handle, k.screen, e.aux + s.start);
  if (!at || !start) return false;
  // A click before the start moves the start, anywhere else the end.
  const ref = e.g.manifest.size('GhosttyGridRef');
  e.u8().copyWithin(e.aux + (before(at, start) ? s.start : s.end), clicked, clicked + ref);
  e.dv().setUint8(e.aux + s.rectangle, 0);
  return fn.ghostty_terminal_set(handle, k.setSelection, e.aux) === 0;
}

/** The selection as text (soft-wrapped lines joined, trailing blanks trimmed) and as VT (its styles); null when there is none. */
export function selectedText(t: VtTerminal): { text: string; vt: string; startX: number } | null {
  const b = selectionBounds(t);
  if (!b) return null;
  const range = { from: { tag: 'screen' as const, ...b.start }, to: { tag: 'screen' as const, ...b.end } };
  const text = t.format({ vt: false, unwrap: true, trim: true, ...range });
  const vt = t.format({ vt: true, unwrap: true, trim: true, ...range });
  return { text, vt, startX: b.start.x };
}

/** The OSC 8 link under a view cell; '' when there is none. */
export function hyperlinkAt(t: VtTerminal, cell: ViewCell): string {
  const n = native(t);
  if (!n) return '';
  const { e, handle, k } = n;
  const { fn } = e.g;
  const ref = e.aux;
  if (!viewRef(e, handle, k.viewport, cell, ref)) return '';
  // Most fit the aux area after the ref; a longer one (a signed URL) gets a buffer of the size it says it needs.
  const out = e.aux + 32;
  const cap = 1024 - 32;
  e.dv().setUint32(e.out, 0, true);
  const r = fn.ghostty_grid_ref_hyperlink_uri(ref, out, cap, e.out);
  if (r === 0) return e.text(out, e.dv().getUint32(e.out, true));
  const need = e.dv().getUint32(e.out, true);
  if (r !== OUT_OF_SPACE || need <= cap) return '';
  const big = fn.ghostty_wasm_alloc(need) >>> 0;
  if (!big) return '';
  try {
    if (fn.ghostty_grid_ref_hyperlink_uri(ref, big, need, e.out) !== 0) return '';
    return e.text(big, e.dv().getUint32(e.out, true));
  } finally {
    fn.ghostty_wasm_free(big, need);
  }
}
