import { callback, instantiate, type GhosttyInstance } from './wasm.js';

/** The C API's option, data and formatter numbers used here (libghostty-vt 1.0.1, include/ghostty/vt/*.h). */
const OPT = {
  WRITE_PTY: 2,
  COLOR_FOREGROUND: 12,
  COLOR_BACKGROUND: 13,
  COLOR_CURSOR: 14,
  SCROLLBACK_MAX_BYTES: 28,
  SCROLLBACK_MAX_LINES: 29,
  PROGRESS_REPORT: 31,
  CONTINUATION_MAX_BYTES: 32,
  RESIZE_PULL_SCROLLBACK: 41,
  RESET: 44,
  PROGRAM_STATUS: 47,
} as const;
const DATA = {
  COLS: 1,
  ROWS: 2,
  CURSOR_X: 3,
  CURSOR_Y: 4,
  CURSOR_PENDING_WRAP: 5,
  ACTIVE_SCREEN: 6,
  KITTY_KEYBOARD_FLAGS: 8,
  MOUSE_TRACKING: 11,
  TITLE: 12,
  SCROLLBACK_ROWS: 15,
  MODE: 37,
  VT_GROUND: 38,
} as const;
const FORMAT = { EMIT: 1, UNWRAP: 2, TRIM: 3, SELECTION: 4, EXTRAS: 5 } as const;
/** GhosttyFormatterTerminalExtra bits: state the formatter writes after the content. */
export const EXTRA = {
  SCROLLING_REGION: 4,
  KEYBOARD: 32,
  STYLE: 128,
  HYPERLINK: 256,
  PROTECTION: 512,
  KITTY_KEYBOARD: 1024,
  CHARSETS: 2048,
} as const;
const POINT_TAG = { active: 0, screen: 2 } as const;
const SUCCESS = 0;
/** A mode number with this bit is an ANSI mode (CSI n h), without it a DEC private one (CSI ? n h). */
const ANSI_MODE = 0x8000;
const SIZE_MAX = 0xffffffff;
/** The longest unfinished sequence the terminal keeps for `continuation()` (its default keeps none). */
const CONTINUATION_MAX = 64 * 1024;

/** OSC 9;4 as libghostty parsed it: ConEmu's state, percent -1 when none was given. */
export interface NativeProgress {
  state: number;
  percent: number;
}
/** OSC 7501 as libghostty parsed it: its enum numbers, progress -1 when none, strings '' when absent. */
export interface NativeProgram {
  state: number;
  kind: number;
  progress: number;
  id: string;
  app: string;
  title: string;
  message: string;
}

/** What the terminal reports while it parses, each called from inside `write` (nothing may write to it then). */
export interface GhosttyEvents {
  /** What it answers a query with (it would write it to the PTY). */
  reply?(data: string): void;
  progress?(report: NativeProgress): void;
  program?(status: NativeProgram): void;
  /** RIS. */
  reset?(): void;
}

export interface GhosttyOptions {
  /** Most lines of scrollback kept (whole pages are dropped, so fewer may be). */
  scrollback: number;
  /** Answer OSC 10, 11, 12 colour queries (with placeholder colours: the caller rewrites the answers). */
  colorQueries?: boolean;
  /** False: a resize never pulls lines back from the scrollback (ConPTY's own reflow). Default true. */
  pullScrollbackOnResize?: boolean;
}

export interface GridPoint {
  /** `active`: rows of the screen; `screen`: rows counted from the top of the scrollback. */
  tag: keyof typeof POINT_TAG;
  x: number;
  y: number;
}

export interface FormatOptions {
  /** VT sequences (true) or plain text. */
  vt: boolean;
  /** Soft-wrapped rows joined into one line. */
  unwrap: boolean;
  /** Trailing blanks and blank rows dropped. */
  trim: boolean;
  /** EXTRA bits. */
  extras?: number;
  /** A range (inclusive), else the whole screen. */
  from?: GridPoint;
  to?: GridPoint;
}

const ALIGN = 8;
const SCRATCH = 256;
const align = (n: number) => Math.ceil(n / ALIGN) * ALIGN;

/** One instance of the module, its memory helpers, and the callbacks that find a terminal by its handle. */
class Engine {
  readonly g: GhosttyInstance;
  /** Out parameters (8 bytes), a value (8 bytes), a GhosttyPoint, a GhosttySelection: 8-aligned. */
  readonly out: number;
  readonly value: number;
  readonly point: number;
  readonly selection: number;
  readonly slot: number;
  readonly terminals = new Map<number, GhosttyTerminal>();
  readonly fnWritePty: number;
  readonly fnProgress: number;
  readonly fnProgram: number;
  readonly fnReset: number;
  private input = 0;
  private inputSize = 0;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor() {
    this.g = instantiate();
    const { fn, layout } = this.g;
    if (layout.point.align > ALIGN || align(16) + align(layout.point.size) + layout.selection.size > SCRATCH) {
      throw new Error('libghostty-vt: structs larger than expected');
    }
    const raw = fn.ghostty_wasm_alloc(SCRATCH + ALIGN) >>> 0;
    if (!raw) throw new Error('libghostty-vt: out of memory');
    this.out = align(raw);
    this.value = this.out + 8;
    this.point = this.out + 16;
    this.selection = this.point + align(layout.point.size);
    this.slot = fn.ghostty_wasm_alloc_opaque() >>> 0;
    const of = (t: number) => this.terminals.get(t)?.events;
    this.fnWritePty = callback(this.g, 4, (t, _ud, ptr, len) => of(t)?.reply?.(this.text(ptr, len)));
    this.fnProgress = callback(this.g, 3, (t, _ud, at) => {
      const p = layout.progress;
      of(t)?.progress?.({ state: this.dv().getUint32((at >>> 0) + p.state, true), percent: this.dv().getInt8((at >>> 0) + p.progress) });
    });
    this.fnProgram = callback(this.g, 3, (t, _ud, at) => {
      const p = layout.program;
      const base = at >>> 0;
      const dv = this.dv();
      of(t)?.program?.({
        state: dv.getUint32(base + p.state, true),
        kind: dv.getUint32(base + p.kind, true),
        progress: dv.getInt8(base + p.progress),
        id: this.string(base + p.id),
        app: this.string(base + p.app),
        title: this.string(base + p.title),
        message: this.string(base + p.message),
      });
    });
    this.fnReset = callback(this.g, 2, (t) => of(t)?.reset?.());
  }

  /** Views of the memory: any call may grow it (and detach the last ones), so they are taken fresh each time. */
  u8(): Uint8Array {
    return new Uint8Array(this.g.memory.buffer);
  }
  dv(): DataView {
    return new DataView(this.g.memory.buffer);
  }

  text(ptr: number, len: number): string {
    const p = ptr >>> 0;
    return len > 0 ? this.decoder.decode(this.u8().subarray(p, p + (len >>> 0))) : '';
  }

  /** A GhosttyString at `at`. */
  string(at: number): string {
    const s = this.g.layout.string;
    const dv = this.dv();
    return this.text(dv.getUint32(at + s.ptr, true), dv.getUint32(at + s.len, true));
  }

  /** `data` as UTF-8 in the instance's input buffer (grown as needed); its pointer and length. */
  encode(data: string): [number, number] {
    const need = data.length * 3;
    if (need > this.inputSize) {
      const { fn } = this.g;
      if (this.input) fn.ghostty_wasm_free(this.input, this.inputSize);
      this.inputSize = Math.max(need, 4096);
      this.input = fn.ghostty_wasm_alloc(this.inputSize) >>> 0;
      if (!this.input) {
        this.inputSize = 0;
        throw new Error('libghostty-vt: out of memory');
      }
    }
    const { written } = this.encoder.encodeInto(data, this.u8().subarray(this.input, this.input + this.inputSize));
    return [this.input, written];
  }

  /** An opaque handle a `_new` call wrote into the slot. */
  take(): number {
    return this.g.fn.ghostty_wasm_take_opaque(this.slot);
  }

  /** Bytes a `_alloc` call wrote to `out` (pointer, length), as text, freed. */
  takeAlloc(): string {
    const dv = this.dv();
    const p = dv.getUint32(this.out, true);
    const n = dv.getUint32(this.out + 4, true);
    if (!p) return '';
    const s = this.text(p, n);
    this.g.fn.ghostty_free(0, p, n);
    return s;
  }
}

function check(result: number, what: string): void {
  if (result !== SUCCESS) throw new Error(`libghostty-vt: ${what} failed (${result})`);
}

/**
 * A libghostty-vt terminal (and its formatter) in an instance of its own. Writes are parsed at once, in the call. Each
 * method is a no-op once freed (reads give 0, '' or false). Not an xterm.js terminal: only what the screen copy needs.
 */
export class GhosttyTerminal {
  private e: Engine | null;
  private readonly handle: number;
  private readonly formatter: number;

  private constructor(
    e: Engine,
    handle: number,
    readonly events: GhosttyEvents,
    private readonly owner: boolean,
  ) {
    this.e = e;
    this.handle = handle;
    const { fn } = e.g;
    check(fn.ghostty_formatter_terminal_new(0, e.slot, handle), 'formatter_new');
    this.formatter = e.take();
    e.terminals.set(handle, this);
    check(fn.ghostty_terminal_set(handle, OPT.WRITE_PTY, e.fnWritePty), 'set write_pty');
  }

  /** Throws if libghostty-vt can't be loaded or the terminal made. */
  static create(cols: number, rows: number, opts: GhosttyOptions, events: GhosttyEvents = {}): GhosttyTerminal {
    const e = new Engine();
    const { fn } = e.g;
    check(fn.ghostty_terminal_new(0, e.slot, cols, rows), 'terminal_new');
    const t = new GhosttyTerminal(e, e.take(), events, true);
    const dv = () => e.dv();
    const setValue = (opt: number, what: string) => check(fn.ghostty_terminal_set(t.handle, opt, e.value), what);
    dv().setUint32(e.value, SIZE_MAX, true);
    setValue(OPT.SCROLLBACK_MAX_BYTES, 'scrollback bytes');
    dv().setUint32(e.value, opts.scrollback, true);
    setValue(OPT.SCROLLBACK_MAX_LINES, 'scrollback lines');
    dv().setUint32(e.value, CONTINUATION_MAX, true);
    setValue(OPT.CONTINUATION_MAX_BYTES, 'continuation');
    if (opts.pullScrollbackOnResize === false) {
      dv().setUint8(e.value, 0);
      setValue(OPT.RESIZE_PULL_SCROLLBACK, 'resize pull');
    }
    if (opts.colorQueries) {
      const rgb = e.g.layout.rgb;
      for (const opt of [OPT.COLOR_FOREGROUND, OPT.COLOR_BACKGROUND, OPT.COLOR_CURSOR]) {
        for (const at of [rgb.r, rgb.g, rgb.b]) dv().setUint8(e.value + at, 0);
        setValue(opt, 'colour');
      }
    }
    if (events.progress) check(fn.ghostty_terminal_set(t.handle, OPT.PROGRESS_REPORT, e.fnProgress), 'set progress');
    if (events.program) check(fn.ghostty_terminal_set(t.handle, OPT.PROGRAM_STATUS, e.fnProgram), 'set program status');
    if (events.reset) check(fn.ghostty_terminal_set(t.handle, OPT.RESET, e.fnReset), 'set reset');
    return t;
  }

  get alive(): boolean {
    return this.e !== null;
  }

  /** Parsed now; the events fire during the call. */
  write(data: string): void {
    const e = this.e;
    if (!e || !data) return;
    const [ptr, len] = e.encode(data);
    e.g.fn.ghostty_terminal_vt_write(this.handle, ptr, len);
  }

  /** False if it was refused (or freed). */
  resize(cols: number, rows: number): boolean {
    return !!this.e && this.e.g.fn.ghostty_terminal_resize(this.handle, cols, rows, 0, 0) === SUCCESS;
  }

  private get(data: number, read: (dv: DataView, at: number) => number): number {
    const e = this.e;
    if (!e) return 0;
    e.dv().setBigUint64(e.value, 0n, true);
    if (e.g.fn.ghostty_terminal_get(this.handle, data, e.value) !== SUCCESS) return 0;
    return read(e.dv(), e.value);
  }
  private u16 = (data: number) => this.get(data, (dv, at) => dv.getUint16(at, true));
  private u32 = (data: number) => this.get(data, (dv, at) => dv.getUint32(at, true));
  private bool = (data: number) => this.get(data, (dv, at) => dv.getUint8(at)) !== 0;

  get cols(): number {
    return this.u16(DATA.COLS);
  }
  get rows(): number {
    return this.u16(DATA.ROWS);
  }
  /** The cursor on the screen (0-based); `pendingWrap`: past the last column, waiting to wrap. */
  cursor(): { x: number; y: number; pendingWrap: boolean } {
    return { x: this.u16(DATA.CURSOR_X), y: this.u16(DATA.CURSOR_Y), pendingWrap: this.bool(DATA.CURSOR_PENDING_WRAP) };
  }
  screen(): 'normal' | 'alternate' {
    return this.u32(DATA.ACTIVE_SCREEN) === 1 ? 'alternate' : 'normal';
  }
  /** Rows of scrollback above the screen. */
  scrollbackRows(): number {
    return this.u32(DATA.SCROLLBACK_ROWS);
  }
  kittyKeyboardFlags(): number {
    return this.get(DATA.KITTY_KEYBOARD_FLAGS, (dv, at) => dv.getUint8(at));
  }
  /** Any mouse tracking (9, 1000, 1002, 1003) in effect. */
  mouseTracking(): boolean {
    return this.bool(DATA.MOUSE_TRACKING);
  }
  /** The parser is between sequences. */
  ground(): boolean {
    return this.bool(DATA.VT_GROUND);
  }

  /** A DEC private mode (`?n`), or an ANSI one with `ansi`. */
  mode(n: number, ansi = false): boolean {
    const e = this.e;
    if (!e) return false;
    const m = e.g.layout.modeConfig;
    const dv = e.dv();
    dv.setUint16(e.value + m.mode, n | (ansi ? ANSI_MODE : 0), true);
    dv.setUint8(e.value + m.value, 0);
    if (e.g.fn.ghostty_terminal_get(this.handle, DATA.MODE, e.value) !== SUCCESS) return false;
    return e.dv().getUint8(e.value + m.value) !== 0;
  }

  /** OSC 0 / 2; '' when none. */
  title(): string {
    const e = this.e;
    if (!e) return '';
    if (e.g.fn.ghostty_terminal_get(this.handle, DATA.TITLE, e.value) !== SUCCESS) return '';
    return e.string(e.value);
  }

  /** The screen (or the range) as text or VT sequences. Throws if the range can't be resolved. */
  format(o: FormatOptions): string {
    const e = this.e;
    if (!e) return '';
    const { fn, layout } = e.g;
    const set = (opt: number, write: (dv: DataView) => void) => {
      write(e.dv());
      check(fn.ghostty_formatter_set(this.formatter, opt, e.value), 'formatter_set');
    };
    set(FORMAT.EMIT, (dv) => dv.setUint32(e.value, o.vt ? 1 : 0, true));
    set(FORMAT.UNWRAP, (dv) => dv.setUint8(e.value, o.unwrap ? 1 : 0));
    set(FORMAT.TRIM, (dv) => dv.setUint8(e.value, o.trim ? 1 : 0));
    set(FORMAT.EXTRAS, (dv) => dv.setUint32(e.value, o.extras ?? 0, true));
    if (o.from && o.to) {
      const s = layout.selection;
      this.gridRef(o.from, e.selection + s.start);
      this.gridRef(o.to, e.selection + s.end);
      e.dv().setUint8(e.selection + s.rectangle, 0);
      check(fn.ghostty_formatter_set(this.formatter, FORMAT.SELECTION, e.selection), 'formatter selection');
    } else {
      check(fn.ghostty_formatter_set(this.formatter, FORMAT.SELECTION, 0), 'formatter selection');
    }
    check(fn.ghostty_formatter_format_alloc(this.formatter, 0, e.out, e.out + 4), 'format');
    return e.takeAlloc();
  }

  private gridRef(p: GridPoint, into: number): void {
    const e = this.e;
    if (!e) return;
    const pt = e.g.layout.point;
    const dv = e.dv();
    for (let i = 0; i < pt.size; i++) dv.setUint8(e.point + i, 0);
    dv.setUint32(e.point + pt.tag, POINT_TAG[p.tag], true);
    dv.setUint16(e.point + pt.x, p.x, true);
    dv.setUint32(e.point + pt.y, p.y, true);
    check(e.g.fn.ghostty_terminal_grid_ref(this.handle, e.point, into), `grid_ref ${p.tag} ${p.x},${p.y}`);
  }

  /** The unfinished sequence the parser is in the middle of, as written so far; '' at ground. */
  continuation(): string {
    const e = this.e;
    if (!e) return '';
    if (e.g.fn.ghostty_terminal_continuation_alloc(this.handle, 0, e.out, e.out + 4) !== SUCCESS) return '';
    return e.takeAlloc();
  }

  /**
   * A copy of this terminal (libghostty's binary snapshot, decoded) in the same instance, to try sequences on without
   * touching this one; only `reply` of its events is wired. Free it when done: it uses this instance's memory.
   */
  clone(events: Pick<GhosttyEvents, 'reply'>): GhosttyTerminal {
    const e = this.e;
    if (!e) throw new Error('libghostty-vt: terminal freed');
    const { fn } = e.g;
    check(fn.ghostty_snapshot_encode_alloc(this.handle, 0, e.out, e.out + 4), 'snapshot encode');
    const dv = e.dv();
    const p = dv.getUint32(e.out, true);
    const n = dv.getUint32(e.out + 4, true);
    try {
      check(fn.ghostty_snapshot_decoder_new_buf(0, e.slot, p, n), 'snapshot decoder');
      const decoder = e.take();
      try {
        check(fn.ghostty_snapshot_decoder_decode(decoder, e.slot), 'snapshot decode');
        return new GhosttyTerminal(e, e.take(), events, false);
      } finally {
        fn.ghostty_snapshot_decoder_free(decoder);
      }
    } finally {
      if (p) fn.ghostty_free(0, p, n);
    }
  }

  /** Frees it; the instance goes with the terminal that made it (a clone only frees itself). */
  free(): void {
    const e = this.e;
    if (!e) return;
    this.e = null;
    e.terminals.delete(this.handle);
    e.g.fn.ghostty_formatter_free(this.formatter);
    e.g.fn.ghostty_terminal_free(this.handle);
    if (this.owner) for (const other of [...e.terminals.values()]) other.free();
  }
}
