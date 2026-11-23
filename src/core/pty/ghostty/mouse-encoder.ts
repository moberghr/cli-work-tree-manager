import { check, type VtEngine, type VtTerminal } from './vt-terminal.js';

/**
 * Mouse reports as the program asked for them (mouse/encoder.h, mouse/event.h): libghostty's own encoder, so the
 * tracking mode (9, 1000, 1002, 1003) decides which presses, releases and moves are sent, and the format (X10, UTF-8,
 * SGR 1006, urxvt 1015, SGR pixels 1016) how. Pure: the browser's ghostty engine turns a pointer or wheel event into a
 * MouseInput and sends what this returns.
 */

/** A pointer event as the encoder needs it. */
export interface MouseInput {
  action: 'press' | 'release' | 'motion';
  /** 1 left, 2 right, 3 middle, 4/5 wheel up/down, 6/7 wheel left/right, 8–11 the extra buttons; 0 none (a move with no button held). */
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** Where, in surface pixels from the grid's top-left corner (outside the grid while a drag goes past it). */
  x: number;
  y: number;
}

/** The drawn grid in surface pixels: what the cell under a position is, and what SGR pixel reports (1016) count in. */
export interface MouseSurface {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  /** Room right of the grid (the scrollbar's gutter) and below it (the part row the cell height doesn't fill). */
  paddingRight: number;
  paddingBottom: number;
}

const MODS = { SHIFT: 1, CTRL: 2, ALT: 4, SUPER: 8 } as const;
/** The DEC modes that say what to report and how: X10, normal, button, any-event tracking; UTF-8, SGR, urxvt, SGR pixels. */
const MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016] as const;
const OUT_CAP = 64;
/** The output, then the size struct and the position (8-aligned). */
const SIZE_AT = OUT_CAP;
const POS_AT = OUT_CAP + 64;
const BUF = POS_AT + 16;

export class MouseEncoder {
  private e: VtEngine | null;
  private readonly t: VtTerminal;
  private readonly terminal: number;
  private readonly encoder: number;
  /** The mouse modes the encoder was last set from: set again only when they change, as that forgets the last cell. */
  private modes = -1;
  private readonly event: number;
  private readonly raw: number;
  private readonly buf: number;
  private readonly actions: { press: number; release: number; motion: number };
  private readonly opt: { size: number; anyPressed: number; trackLastCell: number };

  private constructor(t: VtTerminal) {
    const n = t.native;
    if (!n) throw new Error('libghostty-vt: terminal freed');
    const e = n.e;
    this.e = e;
    this.t = t;
    this.terminal = n.handle;
    const { fn, manifest: m } = e.g;
    if (m.size('GhosttyMouseEncoderSize') > POS_AT - SIZE_AT || m.size('GhosttyMousePosition') > BUF - POS_AT) {
      throw new Error('libghostty-vt: mouse structs larger than expected');
    }
    check(fn.ghostty_mouse_encoder_new(0, e.slot), 'mouse_encoder_new');
    this.encoder = e.take();
    check(fn.ghostty_mouse_event_new(0, e.slot), 'mouse_event_new');
    this.event = e.take();
    this.raw = fn.ghostty_wasm_alloc(BUF + 8) >>> 0;
    if (!this.raw) throw new Error('libghostty-vt: out of memory');
    this.buf = Math.ceil(this.raw / 8) * 8;
    const A = 'GhosttyMouseAction';
    this.actions = { press: m.value(A, 'PRESS'), release: m.value(A, 'RELEASE'), motion: m.value(A, 'MOTION') };
    const O = 'GhosttyMouseEncoderOption';
    this.opt = { size: m.value(O, 'SIZE'), anyPressed: m.value(O, 'ANY_BUTTON_PRESSED'), trackLastCell: m.value(O, 'TRACK_LAST_CELL') };
    // A move within the cell last reported sends nothing (a program asked for cells, not pixels).
    e.dv().setUint8(this.buf, 1);
    check(fn.ghostty_mouse_encoder_set(this.encoder, this.opt.trackLastCell, this.buf), 'mouse track last cell');
  }

  /** An encoder for `t`'s modes (freed separately, before the terminal). */
  static create(t: VtTerminal): MouseEncoder {
    return new MouseEncoder(t);
  }

  /** The grid as drawn now; call on every resize or font change. */
  resize(s: MouseSurface): void {
    const e = this.e;
    if (!e) return;
    const m = e.g.manifest;
    const S = 'GhosttyMouseEncoderSize';
    const at = this.buf + SIZE_AT;
    e.u8().fill(0, at, at + m.size(S));
    const dv = e.dv();
    const u32 = (field: string, v: number) => dv.setUint32(at + m.offset(S, field), Math.max(0, Math.round(v)), true);
    u32('size', m.size(S));
    u32('screen_width', s.width);
    u32('screen_height', s.height);
    u32('cell_width', Math.max(1, s.cellWidth));
    u32('cell_height', Math.max(1, s.cellHeight));
    u32('padding_right', s.paddingRight);
    u32('padding_bottom', s.paddingBottom);
    check(e.g.fn.ghostty_mouse_encoder_set(this.encoder, this.opt.size, at), 'mouse size');
  }

  /** What to send for the event as the terminal's modes are now; '' when nothing (no tracking, a move it didn't ask for). */
  encode(input: MouseInput, anyPressed: boolean): string {
    const e = this.e;
    if (!e) return '';
    const { fn, manifest: m } = e.g;
    let modes = 0;
    for (let i = 0; i < MOUSE_MODES.length; i++) if (this.t.mode(MOUSE_MODES[i]!)) modes |= 1 << i;
    if (modes !== this.modes) {
      this.modes = modes;
      fn.ghostty_mouse_encoder_set_from_terminal(this.encoder, this.terminal);
    }
    e.dv().setUint8(this.buf, anyPressed ? 1 : 0);
    fn.ghostty_mouse_encoder_set(this.encoder, this.opt.anyPressed, this.buf);
    const ev = this.event;
    fn.ghostty_mouse_event_set_action(ev, this.actions[input.action]);
    if (input.button > 0) fn.ghostty_mouse_event_set_button(ev, input.button);
    else fn.ghostty_mouse_event_clear_button(ev);
    const mods = (input.shift ? MODS.SHIFT : 0) | (input.ctrl ? MODS.CTRL : 0) | (input.alt ? MODS.ALT : 0) | (input.meta ? MODS.SUPER : 0);
    fn.ghostty_mouse_event_set_mods(ev, mods);
    const P = 'GhosttyMousePosition';
    const pos = this.buf + POS_AT;
    e.dv().setFloat32(pos + m.offset(P, 'x'), input.x, true);
    e.dv().setFloat32(pos + m.offset(P, 'y'), input.y, true);
    fn.ghostty_mouse_event_set_position(ev, pos);
    e.dv().setUint32(e.out, 0, true);
    if (fn.ghostty_mouse_encoder_encode(this.encoder, ev, this.buf, OUT_CAP, e.out) !== 0) return '';
    return e.text(this.buf, e.dv().getUint32(e.out, true));
  }

  free(): void {
    const e = this.e;
    if (!e) return;
    this.e = null;
    e.g.fn.ghostty_mouse_event_free(this.event);
    e.g.fn.ghostty_mouse_encoder_free(this.encoder);
    e.g.fn.ghostty_wasm_free(this.raw, BUF + 8);
  }
}
