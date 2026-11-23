import { afterEach, describe, expect, it } from 'vitest';
import { instantiate } from '../../../../src/core/pty/ghostty/wasm.js';
import { VtTerminal } from '../../../../src/core/pty/ghostty/vt-terminal.js';
import { encodeFocus, encodePaste, ghosttyKeyName, KeyEncoder, type KeyInput } from '../../../../src/core/pty/ghostty/key-encoder.js';

let open: { t: VtTerminal; k: KeyEncoder }[] = [];

function make() {
  const t = VtTerminal.create(instantiate(), 80, 24, { scrollback: 100 });
  const k = KeyEncoder.create(t);
  open.push({ t, k });
  return { t, k };
}

const key = (code: string, text = '', mods: Partial<KeyInput> = {}): KeyInput => ({
  code,
  text,
  unshifted: text.length === 1 ? text.toLowerCase().codePointAt(0)! : 0,
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  ...mods,
});

afterEach(() => {
  for (const { t, k } of open) {
    k.free();
    t.free();
  }
  open = [];
});

describe('ghosttyKeyName', () => {
  it("names a KeyboardEvent.code as libghostty's GhosttyKey does", () => {
    expect(ghosttyKeyName('KeyA')).toBe('A');
    expect(ghosttyKeyName('ArrowUp')).toBe('ARROW_UP');
    expect(ghosttyKeyName('Digit1')).toBe('DIGIT_1');
    expect(ghosttyKeyName('Numpad0')).toBe('NUMPAD_0');
    expect(ghosttyKeyName('F12')).toBe('F12');
    expect(ghosttyKeyName('BracketLeft')).toBe('BRACKET_LEFT');
    expect(ghosttyKeyName('PageDown')).toBe('PAGE_DOWN');
  });
});

describe('KeyEncoder', () => {
  it('types text as itself, and Enter, Backspace, Tab and Escape as their controls', () => {
    const { k } = make();
    expect(k.encode(key('KeyA', 'a'))).toBe('a');
    expect(k.encode(key('KeyA', 'A', { shift: true, consumed: { shift: true } }))).toBe('A');
    expect(k.encode(key('Enter'))).toBe('\r');
    expect(k.encode(key('Backspace'))).toBe('\x7f');
    expect(k.encode(key('Tab'))).toBe('\t');
    expect(k.encode(key('Escape'))).toBe('\x1b');
  });

  it('sends the cursor keys in normal mode, and in application mode once a program sets DECCKM', () => {
    const { t, k } = make();
    expect(k.encode(key('ArrowUp'))).toBe('\x1b[A');
    expect(k.encode(key('ArrowLeft'))).toBe('\x1b[D');
    t.write('\x1b[?1h');
    expect(k.encode(key('ArrowUp'))).toBe('\x1bOA');
    expect(k.encode(key('ArrowLeft'))).toBe('\x1bOD');
    t.write('\x1b[?1l');
    expect(k.encode(key('ArrowUp'))).toBe('\x1b[A');
  });

  it('sends Ctrl+C as ETX, Alt+letter with an ESC before it, and a modified arrow with its modifiers', () => {
    const { k } = make();
    expect(k.encode(key('KeyC', 'c', { ctrl: true }))).toBe('\x03');
    expect(k.encode(key('KeyX', 'x', { alt: true }))).toBe('\x1bx');
    expect(k.encode(key('ArrowRight', '', { ctrl: true }))).toBe('\x1b[1;5C');
  });

  it("sends macOS Option's character when Option composed it", () => {
    const { k } = make();
    expect(k.encode(key('KeyA', 'å', { alt: true, consumed: { alt: true } }))).toBe('å');
  });

  it('sends nothing for a modifier alone, or for a release nobody asked for', () => {
    const { k } = make();
    expect(k.encode(key('ShiftLeft', '', { shift: true }))).toBe('');
    expect(k.encode(key('KeyA', 'a', { action: 'release' }))).toBe('');
  });

  it('speaks the kitty keyboard protocol once a program pushes its flags', () => {
    const { t, k } = make();
    t.write('\x1b[>1u'); // disambiguate
    expect(k.encode(key('Escape'))).toBe('\x1b[27u');
    expect(k.encode(key('KeyC', 'c', { ctrl: true }))).toBe('\x1b[99;5u');
    expect(k.encode(key('KeyA', 'a'))).toBe('a');
    t.write('\x1b[<u'); // pop
    expect(k.encode(key('Escape'))).toBe('\x1b');
  });
});

describe('focus and paste', () => {
  it('encodes focus in and out', () => {
    const { t } = make();
    expect(encodeFocus(t, true)).toBe('\x1b[I');
    expect(encodeFocus(t, false)).toBe('\x1b[O');
  });

  it('brackets a paste only when the program asked for it (mode 2004)', () => {
    const { t } = make();
    expect(encodePaste(t, 'hello')).toBe('hello');
    t.write('\x1b[?2004h');
    expect(encodePaste(t, 'hello')).toBe('\x1b[200~hello\x1b[201~');
  });
});
