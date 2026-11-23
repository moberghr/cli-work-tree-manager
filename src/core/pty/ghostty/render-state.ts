import { check, type VtEngine, type VtTerminal } from './vt-terminal.js';

/**
 * libghostty-vt's render state (render.h) for a renderer: what the view shows, row by row, and which rows changed since
 * the last frame. A row is read whole with one call (its raw cells, GhosttyCellsView), its packed bits parsed with the
 * module's own manifest; a cell's style and grapheme cost a call each, only for cells that have one (a row's styles
 * are looked up once per style). Colours come back as 0xRRGGBB, -1 for the default. Pure: the browser's ghostty
 * engine uses it.
 */

/** Style bits as the renderer reads them (work's, not the C ABI's: those are read from the manifest). */
export const STYLE = { BOLD: 1, ITALIC: 2, FAINT: 4, BLINK: 8, INVERSE: 16, INVISIBLE: 32, STRIKE: 64, OVERLINE: 128 } as const;
/** GhosttySgrUnderline: none, single, double, curly, dotted, dashed. */
export type Underline = 0 | 1 | 2 | 3 | 4 | 5;

/** One row, per column (reused from row to row: copy what you keep). */
export interface RowCells {
  cols: number;
  /** The cell's text: '' when blank or the second half of a wide character. */
  text: string[];
  /** 1, 2 for a wide character's first cell, 0 for its second. */
  width: Uint8Array;
  fg: Int32Array;
  bg: Int32Array;
  /** Underline colour, -1 for the text's. */
  ul: Int32Array;
  /** STYLE bits. */
  flags: Uint16Array;
  underline: Uint8Array;
}

export type CursorStyle = 'bar' | 'block' | 'underline' | 'block_hollow';

export interface CursorState {
  /** In the view (false: hidden, or scrolled out of it). */
  visible: boolean;
  x: number;
  y: number;
  style: CursorStyle;
  blinking: boolean;
  /** On the second half of a wide character. */
  wideTail: boolean;
}

export interface ColorState {
  background: number;
  foreground: number;
  /** -1: none set (draw it in the text's colour). */
  cursor: number;
  /** 256 colours. */
  palette: Int32Array;
}

export type Dirty = 'none' | 'partial' | 'full';

const DATA = { COLS: 1, ROWS: 2, DIRTY: 3, ROW_ITERATOR: 4, CURSOR: 18, COLORS: 19 } as const;
const ROW = { CELLS: 3, CELLS_RAW: 5 } as const;
const CELL = { STYLE: 2, GRAPHEMES_UTF8: 9 } as const;
const CURSOR_STYLES: readonly CursorStyle[] = ['bar', 'block', 'underline', 'block_hollow'];
const GRAPHEME_CAP = 128;

type Bits = { lsb: number; width: number };
/** A field of a 64-bit packed value read as its low and high halves. */
function field(lo: number, hi: number, b: Bits): number {
  const mask = b.width >= 32 ? 0xffffffff : (1 << b.width) - 1;
  if (b.lsb >= 32) return (hi >>> (b.lsb - 32)) & mask;
  if (b.lsb + b.width <= 32) return (lo >>> b.lsb) & mask;
  return ((lo >>> b.lsb) | (hi << (32 - b.lsb))) & mask;
}

const rgbOf = (u8: Uint8Array, at: number): number => (u8[at]! << 16) | (u8[at + 1]! << 8) | u8[at + 2]!;

interface Style {
  fg: number;
  bg: number;
  ul: number;
  flags: number;
  underline: Underline;
}

export class RenderState {
  private e: VtEngine | null;
  private readonly terminal: number;
  private readonly state: number;
  private readonly iterator: number;
  private readonly cells: number;
  /** Where the handles of the iterator and the row's cells are kept (the get calls take their address). */
  private readonly handles: number;
  private readonly grapheme: number;
  private readonly cell: { tag: Bits; content: Bits; style: Bits; wide: Bits };
  private readonly tags: { grapheme: number; bgPalette: number; bgRgb: number };
  private readonly wides: { wide: number; tail: number };
  private readonly flagBits: { name: keyof typeof STYLE; bits: Bits }[];
  private readonly underlineBits: Bits;
  private readonly lastColors: Uint8Array;
  private readonly decoder = new TextDecoder();
  private colorState: ColorState = { background: 0, foreground: 0xffffff, cursor: -1, palette: new Int32Array(256) };
  private row: RowCells = blankRow(0);

  private constructor(t: VtTerminal) {
    const n = t.native;
    if (!n) throw new Error('libghostty-vt: terminal freed');
    const e = n.e;
    this.e = e;
    this.terminal = n.handle;
    const { fn, manifest: m } = e.g;
    check(fn.ghostty_render_state_new(0, e.slot), 'render_state_new');
    this.state = e.take();
    check(fn.ghostty_render_state_row_iterator_new(0, e.slot), 'row_iterator_new');
    this.iterator = e.take();
    check(fn.ghostty_render_state_row_cells_new(0, e.slot), 'row_cells_new');
    this.cells = e.take();
    this.handles = fn.ghostty_wasm_alloc(16 + GRAPHEME_CAP) >>> 0;
    if (!this.handles) throw new Error('libghostty-vt: out of memory');
    this.grapheme = this.handles + 16;
    const dv = e.dv();
    dv.setUint32(this.handles, this.iterator, true);
    dv.setUint32(this.handles + 4, this.cells, true);
    const C = 'GhosttyCell';
    this.cell = { tag: m.bits(C, 'content_tag'), content: m.bits(C, 'content'), style: m.bits(C, 'style_id'), wide: m.bits(C, 'wide') };
    const T = 'GhosttyCellContentTag';
    this.tags = {
      grapheme: m.value(T, 'CODEPOINT_GRAPHEME'),
      bgPalette: m.value(T, 'BG_COLOR_PALETTE'),
      bgRgb: m.value(T, 'BG_COLOR_RGB'),
    };
    this.wides = { wide: m.value('GhosttyCellWide', 'WIDE'), tail: m.value('GhosttyCellWide', 'SPACER_TAIL') };
    const F = 'GhosttyStyleFlags';
    const names: [keyof typeof STYLE, string][] = [
      ['BOLD', 'bold'],
      ['ITALIC', 'italic'],
      ['FAINT', 'faint'],
      ['BLINK', 'blink'],
      ['INVERSE', 'inverse'],
      ['INVISIBLE', 'invisible'],
      ['STRIKE', 'strikethrough'],
      ['OVERLINE', 'overline'],
    ];
    this.flagBits = names.map(([name, f]) => ({ name, bits: m.bits(F, f) }));
    this.underlineBits = m.bits(F, 'underline');
    this.lastColors = new Uint8Array(m.size('GhosttyRenderStateColors'));
  }

  /** A render state for `t` (freed separately, before the terminal). */
  static create(t: VtTerminal): RenderState {
    return new RenderState(t);
  }

  private engine(): VtEngine {
    if (!this.e) throw new Error('libghostty-vt: render state freed');
    return this.e;
  }

  private getU(data: number, size: 2 | 4): number {
    const e = this.engine();
    e.dv().setUint32(e.value, 0, true);
    if (e.g.fn.ghostty_render_state_get(this.state, data, e.value) !== 0) return 0;
    return size === 2 ? e.dv().getUint16(e.value, true) : e.dv().getUint32(e.value, true);
  }

  /** Takes in what the terminal changed since the last update; what needs drawing. */
  update(): Dirty {
    const e = this.engine();
    check(e.g.fn.ghostty_render_state_update(this.state, this.terminal), 'render_state_update');
    const d = this.getU(DATA.DIRTY, 4);
    return d === 2 ? 'full' : d === 1 ? 'partial' : 'none';
  }

  get cols(): number {
    return this.getU(DATA.COLS, 2);
  }
  get rows(): number {
    return this.getU(DATA.ROWS, 2);
  }

  cursor(): CursorState {
    const e = this.engine();
    const m = e.g.manifest;
    const S = 'GhosttyRenderStateCursor';
    const size = m.size(S);
    e.u8().fill(0, e.aux, e.aux + size);
    e.dv().setUint32(e.aux + m.offset(S, 'size'), size, true);
    check(e.g.fn.ghostty_render_state_get(this.state, DATA.CURSOR, e.aux), 'cursor');
    const dv = e.dv();
    const at = (f: string) => e.aux + m.offset(S, f);
    const has = dv.getUint8(at('viewport_has_value')) !== 0;
    return {
      visible: has && dv.getUint8(at('visible')) !== 0,
      x: dv.getUint16(at('viewport_x'), true),
      y: dv.getUint16(at('viewport_y'), true),
      style: CURSOR_STYLES[dv.getUint32(at('visual_style'), true)] ?? 'block',
      blinking: dv.getUint8(at('blinking')) !== 0,
      wideTail: dv.getUint8(at('wide_tail')) !== 0,
    };
  }

  /** The colours in effect (a program may have changed them); `changed` when they differ from the last call's. */
  colors(): { colors: ColorState; changed: boolean } {
    const e = this.engine();
    const m = e.g.manifest;
    const S = 'GhosttyRenderStateColors';
    const size = this.lastColors.length;
    e.u8().fill(0, e.aux, e.aux + size);
    e.dv().setUint32(e.aux + m.offset(S, 'size'), size, true);
    check(e.g.fn.ghostty_render_state_get(this.state, DATA.COLORS, e.aux), 'colors');
    const now = e.u8().subarray(e.aux, e.aux + size);
    let same = true;
    for (let i = 0; i < size; i++) {
      if (now[i] !== this.lastColors[i]) {
        same = false;
        break;
      }
    }
    if (same) return { colors: this.colorState, changed: false };
    this.lastColors.set(now);
    const u8 = this.lastColors;
    const palette = new Int32Array(256);
    const p = m.offset(S, 'palette');
    for (let i = 0; i < 256; i++) palette[i] = rgbOf(u8, p + i * 3);
    this.colorState = {
      background: rgbOf(u8, m.offset(S, 'background')),
      foreground: rgbOf(u8, m.offset(S, 'foreground')),
      cursor: u8[m.offset(S, 'cursor_has_value')] ? rgbOf(u8, m.offset(S, 'cursor')) : -1,
      palette,
    };
    return { colors: this.colorState, changed: true };
  }

  /** Each row to redraw, top to bottom (every row with `all`), read into `row` (the same object each time). */
  eachRow(all: boolean, each: (y: number, row: RowCells) => void): void {
    const e = this.engine();
    const { fn } = e.g;
    check(fn.ghostty_render_state_get(this.state, DATA.ROW_ITERATOR, this.handles), 'row iterator');
    let y = -1;
    for (;;) {
      if (all) {
        if (!fn.ghostty_render_state_row_iterator_next(this.iterator)) break;
        y++;
      } else {
        if (!fn.ghostty_render_state_row_iterator_next_dirty(this.iterator, e.out)) break;
        y = e.dv().getUint16(e.out, true);
      }
      each(y, this.readRow(e));
    }
  }

  private readRow(e: VtEngine): RowCells {
    const { fn, manifest: m } = e.g;
    check(fn.ghostty_render_state_row_get(this.iterator, ROW.CELLS_RAW, e.aux), 'row cells raw');
    const dv0 = e.dv();
    const ptr = dv0.getUint32(e.aux + m.offset('GhosttyCellsView', 'ptr'), true);
    const len = dv0.getUint32(e.aux + m.offset('GhosttyCellsView', 'len'), true);
    if (this.row.cols !== len) this.row = blankRow(len);
    const row = this.row;
    let cellsReady = false;
    const select = (x: number) => {
      if (!cellsReady) {
        check(fn.ghostty_render_state_row_get(this.iterator, ROW.CELLS, this.handles + 4), 'row cells');
        cellsReady = true;
      }
      check(fn.ghostty_render_state_row_cells_select(this.cells, x), 'cell select');
    };
    const styles = new Map<number, Style>();
    // The raw cells first, all of them, while the view of them is valid (a later call may grow the memory).
    const raw = new Uint32Array(len * 2);
    if (ptr) raw.set(new Uint32Array(e.g.memory.buffer, ptr, len * 2));
    for (let x = 0; x < len; x++) {
      const lo = raw[x * 2]!;
      const hi = raw[x * 2 + 1]!;
      const tag = field(lo, hi, this.cell.tag);
      const content = field(lo, hi, this.cell.content);
      const styleId = field(lo, hi, this.cell.style);
      const wide = field(lo, hi, this.cell.wide);
      let style: Style | undefined;
      if (styleId) {
        style = styles.get(styleId);
        if (!style) {
          select(x);
          style = this.readStyle(e);
          styles.set(styleId, style);
        }
      }
      row.fg[x] = style?.fg ?? -1;
      row.bg[x] = style?.bg ?? -1;
      row.ul[x] = style?.ul ?? -1;
      row.flags[x] = style?.flags ?? 0;
      row.underline[x] = style?.underline ?? 0;
      row.width[x] = wide === this.wides.wide ? 2 : wide === this.wides.tail ? 0 : 1;
      if (tag === this.tags.bgPalette) {
        row.bg[x] = this.colorState.palette[content & 0xff]!;
        row.text[x] = '';
      } else if (tag === this.tags.bgRgb) {
        row.bg[x] = ((content & 0xff) << 16) | (((content >>> 8) & 0xff) << 8) | ((content >>> 16) & 0xff);
        row.text[x] = '';
      } else {
        const cp = content & 0x1fffff;
        row.text[x] = cp === 0 ? '' : tag === this.tags.grapheme ? this.readGrapheme(e, x, cp, select) : String.fromCodePoint(cp);
      }
    }
    return row;
  }

  private color(dv: DataView, at: number, bold: boolean): number {
    const tag = dv.getUint8(at);
    if (tag === 1) {
      const i = dv.getUint8(at + 1);
      return this.colorState.palette[bold && i < 8 ? i + 8 : i]!;
    }
    if (tag === 2) return (dv.getUint8(at + 1) << 16) | (dv.getUint8(at + 2) << 8) | dv.getUint8(at + 3);
    return -1;
  }

  /** The selected cell's style; a bold text in one of the first 8 palette colours drawn in its bright one, as xterm.js does. */
  private readStyle(e: VtEngine): Style {
    const m = e.g.manifest;
    check(e.g.fn.ghostty_render_state_row_cells_get(this.cells, CELL.STYLE, e.aux), 'cell style');
    const dv = e.dv();
    const S = 'GhosttyStyle';
    const raw = dv.getUint16(e.aux + m.offset(S, 'flags'), true);
    let flags = 0;
    for (const f of this.flagBits) if (field(raw, 0, f.bits)) flags |= STYLE[f.name];
    const bold = (flags & STYLE.BOLD) !== 0;
    return {
      fg: this.color(dv, e.aux + m.offset(S, 'fg_color'), bold),
      bg: this.color(dv, e.aux + m.offset(S, 'bg_color'), false),
      ul: this.color(dv, e.aux + m.offset(S, 'underline_color'), false),
      flags,
      underline: Math.min(5, field(raw, 0, this.underlineBits)) as Underline,
    };
  }

  private readGrapheme(e: VtEngine, x: number, base: number, select: (x: number) => void): string {
    const m = e.g.manifest;
    select(x);
    const B = 'GhosttyBuffer';
    const dv = e.dv();
    dv.setUint32(e.aux + m.offset(B, 'ptr'), this.grapheme, true);
    dv.setUint32(e.aux + m.offset(B, 'cap'), GRAPHEME_CAP, true);
    dv.setUint32(e.aux + m.offset(B, 'len'), 0, true);
    if (e.g.fn.ghostty_render_state_row_cells_get(this.cells, CELL.GRAPHEMES_UTF8, e.aux) !== 0) return String.fromCodePoint(base);
    const len = e.dv().getUint32(e.aux + m.offset(B, 'len'), true);
    return this.decoder.decode(e.u8().slice(this.grapheme, this.grapheme + len));
  }

  /** The frame was drawn: nothing is dirty until the next update brings changes. */
  clean(): void {
    const e = this.engine();
    e.g.fn.ghostty_render_state_clean(this.state);
  }

  free(): void {
    const e = this.e;
    if (!e) return;
    this.e = null;
    const { fn } = e.g;
    fn.ghostty_render_state_row_cells_free(this.cells);
    fn.ghostty_render_state_row_iterator_free(this.iterator);
    fn.ghostty_render_state_free(this.state);
    fn.ghostty_wasm_free(this.handles, 16 + GRAPHEME_CAP);
  }
}

function blankRow(cols: number): RowCells {
  return {
    cols,
    text: new Array<string>(cols).fill(''),
    width: new Uint8Array(cols),
    fg: new Int32Array(cols),
    bg: new Int32Array(cols),
    ul: new Int32Array(cols),
    flags: new Uint16Array(cols),
    underline: new Uint8Array(cols),
  };
}
