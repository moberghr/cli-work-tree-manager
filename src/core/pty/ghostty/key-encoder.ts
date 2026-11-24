import { check, type VtEngine, type VtTerminal } from './vt-terminal.js';

/**
 * Keys, focus changes and pastes as the terminal's modes want them sent (key/encoder.h, focus.h, paste.h): libghostty's
 * own encoder, so cursor keys follow DECCKM, Ctrl/Alt/Shift combinations modifyOtherKeys, and a program that asked for
 * the kitty keyboard protocol gets it, flags and all. Pure: the browser's ghostty engine turns a KeyboardEvent into a
 * KeyInput and sends what this returns.
 */

/** A key as the encoder needs it. */
export interface KeyInput {
  /** The physical key: KeyboardEvent.code (`KeyA`, `ArrowUp`, `Numpad1`). */
  code: string;
  /** What the key types with its modifiers, Ctrl aside (`A` with Shift, `å` with macOS Option); '' for keys that type nothing (arrows, Enter). */
  text: string;
  /** What it types with no modifier at all (kitty's alternate keys), 0 when not known. */
  unshifted: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** Modifiers spent on `text` (macOS Option composing `å`): not sent again as modifiers. */
  consumed?: { shift?: boolean; alt?: boolean };
  action?: 'press' | 'repeat' | 'release';
  /** In the middle of an input method's composition. */
  composing?: boolean;
}

const MODS = { SHIFT: 1, CTRL: 2, ALT: 4, SUPER: 8 } as const;
const OUT_CAP = 128;
const TEXT_CAP = 64;

/** A KeyboardEvent.code as libghostty's GhosttyKey name: W3C's names in SNAKE_CASE (`ArrowUp` → `ARROW_UP`, `KeyA` → `A`). */
export function ghosttyKeyName(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  return code.replace(/([a-z])([A-Z0-9])/g, '$1_$2').toUpperCase();
}

const mods = (shift: boolean, ctrl: boolean, alt: boolean, meta: boolean): number =>
  (shift ? MODS.SHIFT : 0) | (ctrl ? MODS.CTRL : 0) | (alt ? MODS.ALT : 0) | (meta ? MODS.SUPER : 0);

export class KeyEncoder {
  private e: VtEngine | null;
  private readonly terminal: number;
  private readonly encoder: number;
  private readonly event: number;
  /** The event's text (kept valid while the event lives), the GhosttyString pointing at it, the output. */
  private readonly buf: number;
  private readonly keys: ReadonlyMap<string, number>;
  private readonly actions: { press: number; repeat: number; release: number };
  private readonly unidentified: number;

  private constructor(t: VtTerminal) {
    const n = t.native;
    if (!n) throw new Error('libghostty-vt: terminal freed');
    const e = n.e;
    this.e = e;
    this.terminal = n.handle;
    const { fn, manifest: m } = e.g;
    check(fn.ghostty_key_encoder_new(0, e.slot), 'key_encoder_new');
    this.encoder = e.take();
    check(fn.ghostty_key_event_new(0, e.slot), 'key_event_new');
    this.event = e.take();
    this.buf = fn.ghostty_wasm_alloc(TEXT_CAP + 16 + OUT_CAP) >>> 0;
    if (!this.buf) throw new Error('libghostty-vt: out of memory');
    this.keys = m.values('GhosttyKey');
    this.unidentified = m.value('GhosttyKey', 'UNIDENTIFIED');
    const A = 'GhosttyKeyAction';
    this.actions = { press: m.value(A, 'PRESS'), repeat: m.value(A, 'REPEAT'), release: m.value(A, 'RELEASE') };
  }

  /** An encoder for `t`'s modes (freed separately, before the terminal). */
  static create(t: VtTerminal): KeyEncoder {
    return new KeyEncoder(t);
  }

  /** What to send for the key, as the terminal's modes are now; '' when nothing (a modifier alone, a release nobody asked for). */
  encode(k: KeyInput): string {
    const e = this.e;
    if (!e) return '';
    const { fn } = e.g;
    fn.ghostty_key_encoder_set_from_terminal(this.encoder, this.terminal);
    const ev = this.event;
    fn.ghostty_key_event_set_action(ev, this.actions[k.action ?? 'press']);
    fn.ghostty_key_event_set_key(ev, this.keys.get(ghosttyKeyName(k.code)) ?? this.unidentified);
    fn.ghostty_key_event_set_mods(ev, mods(k.shift, k.ctrl, k.alt, k.meta));
    fn.ghostty_key_event_set_consumed_mods(ev, mods(!!k.consumed?.shift, false, !!k.consumed?.alt, false));
    fn.ghostty_key_event_set_composing(ev, k.composing ? 1 : 0);
    // The text, unless it is a control character (the encoder makes those from the key and its modifiers).
    const text = /^[\x00-\x1f\x7f]/.test(k.text) ? '' : k.text;
    const bytes = new TextEncoder().encode(text).subarray(0, TEXT_CAP);
    e.u8().set(bytes, this.buf);
    const str = this.buf + TEXT_CAP;
    const dv = e.dv();
    dv.setUint32(str + e.g.layout.string.ptr, this.buf, true);
    dv.setUint32(str + e.g.layout.string.len, bytes.length, true);
    fn.ghostty_key_event_set_utf8(ev, str);
    fn.ghostty_key_event_set_unshifted_codepoint(ev, k.unshifted);
    const out = str + 16;
    e.dv().setUint32(e.out, 0, true);
    if (fn.ghostty_key_encoder_encode(this.encoder, ev, out, OUT_CAP, e.out) !== 0) return '';
    return e.text(out, e.dv().getUint32(e.out, true));
  }

  free(): void {
    const e = this.e;
    if (!e) return;
    this.e = null;
    e.g.fn.ghostty_key_event_free(this.event);
    e.g.fn.ghostty_key_encoder_free(this.encoder);
    e.g.fn.ghostty_wasm_free(this.buf, TEXT_CAP + 16 + OUT_CAP);
  }
}

/** The focus report for mode 1004 (CSI I / CSI O); '' if the terminal is freed. */
export function encodeFocus(t: VtTerminal, gained: boolean): string {
  const n = t.native;
  if (!n) return '';
  const { e } = n;
  const { fn, manifest: m } = e.g;
  const event = m.value('GhosttyFocusEvent', gained ? 'GAINED' : 'LOST');
  if (fn.ghostty_focus_encode(event, e.aux, 16, e.out) !== 0) return '';
  return e.text(e.aux, e.dv().getUint32(e.out, true));
}

/**
 * Pasted text as it is sent: inside bracketed-paste markers when the program asked for them (mode 2004), and with what
 * libghostty strips from a paste stripped (an ESC that could end the brackets early, for one).
 */
export function encodePaste(t: VtTerminal, text: string): string {
  const n = t.native;
  if (!n || !text) return '';
  const { e } = n;
  const { fn } = e.g;
  const bracketed = t.mode(2004);
  const [ptr, len] = e.encode(text);
  const cap = len + 32;
  const out = fn.ghostty_wasm_alloc(cap) >>> 0;
  if (!out) throw new Error('libghostty-vt: out of memory');
  try {
    // The input buffer may have moved: encode() returned its address after any growth, and alloc doesn't move it.
    check(fn.ghostty_paste_encode(ptr, len, bracketed ? 1 : 0, out, cap, e.out), 'paste_encode');
    return e.text(out, e.dv().getUint32(e.out, true));
  } finally {
    fn.ghostty_wasm_free(out, cap);
  }
}
