import { afterEach, describe, expect, it } from 'vitest';
import { instantiate } from '../../../../src/core/pty/ghostty/wasm.js';
import { VtTerminal } from '../../../../src/core/pty/ghostty/vt-terminal.js';
import { RenderState, STYLE, type RowCells } from '../../../../src/core/pty/ghostty/render-state.js';
import { themeRgb } from '../../../../src/core/pty/terminal-colors.js';

const theme = themeRgb();
const hex = ([r, g, b]: readonly number[]) => (r! << 16) | (g! << 8) | b!;
let open: { t: VtTerminal; r: RenderState }[] = [];

function make(cols = 20, rows = 5) {
  const t = VtTerminal.create(instantiate(), cols, rows, { scrollback: 100, colors: theme });
  const r = RenderState.create(t);
  open.push({ t, r });
  return { t, r };
}

/** The rows a frame redraws: y → a copy of what the row holds. */
function frame(r: RenderState, all = false): Map<number, { text: string[]; row: RowCells }> {
  r.colors();
  const out = new Map<number, { text: string[]; row: RowCells }>();
  r.eachRow(all, (y, row) =>
    out.set(y, {
      text: [...row.text],
      row: {
        ...row,
        text: [...row.text],
        width: row.width.slice(),
        fg: row.fg.slice(),
        bg: row.bg.slice(),
        ul: row.ul.slice(),
        flags: row.flags.slice(),
        underline: row.underline.slice(),
      },
    }),
  );
  r.clean();
  return out;
}
const line = (text: string[]) => text.join('').trimEnd();

afterEach(() => {
  for (const { t, r } of open) {
    r.free();
    t.free();
  }
  open = [];
});

describe('RenderState', () => {
  it('reads each cell: text, wide characters, colours resolved through the palette (bold in the bright one, as xterm.js)', () => {
    const { t, r } = make();
    t.write('ab\x1b[1;31mR\x1b[0m\x1b[38;2;1;2;3mX\x1b[0m\x1b[48;5;196m \x1b[0m漢z');
    expect(r.update()).toBe('full');
    const { colors } = r.colors();
    expect(colors.background).toBe(hex(theme.background));
    expect(colors.foreground).toBe(hex(theme.foreground));
    expect(colors.palette[196]).toBe(hex(theme.palette[196]!));
    const row = frame(r, true).get(0)!.row;
    expect(row.text.slice(0, 8)).toEqual(['a', 'b', 'R', 'X', ' ', '漢', '', 'z']);
    expect(Array.from(row.width.slice(0, 8))).toEqual([1, 1, 1, 1, 1, 2, 0, 1]);
    expect(row.fg[0]).toBe(-1);
    expect(row.fg[2]).toBe(hex(theme.palette[9]!)); // bold red → bright red
    expect(row.flags[2]! & STYLE.BOLD).toBeTruthy();
    expect(row.fg[3]).toBe(0x010203);
    expect(row.bg[4]).toBe(hex(theme.palette[196]!));
    expect(row.bg[0]).toBe(-1);
  });

  it('reads the styles: italic, faint, inverse, invisible, strikethrough, the underline kinds and their colour', () => {
    const { t, r } = make();
    t.write(
      '\x1b[3mi\x1b[0m\x1b[2mf\x1b[0m\x1b[7mv\x1b[0m\x1b[8mh\x1b[0m\x1b[9ms\x1b[0m\x1b[4:3;58;2;255;0;0mc\x1b[0m\x1b[21md\x1b[0m\x1b[4:4mo\x1b[4:5me',
    );
    r.update();
    const row = frame(r, true).get(0)!.row;
    expect(row.flags[0]).toBe(STYLE.ITALIC);
    expect(row.flags[1]).toBe(STYLE.FAINT);
    expect(row.flags[2]).toBe(STYLE.INVERSE);
    expect(row.flags[3]).toBe(STYLE.INVISIBLE);
    expect(row.flags[4]).toBe(STYLE.STRIKE);
    expect(Array.from(row.underline.slice(5, 9))).toEqual([3, 2, 4, 5]);
    expect(row.ul[5]).toBe(0xff0000);
    expect(row.ul[6]).toBe(-1);
  });

  it('keeps a grapheme cluster whole in its cell (mode 2027)', () => {
    const { t, r } = make();
    t.write('\x1b[?2027h👍🏽!');
    r.update();
    const row = frame(r, true).get(0)!.row;
    expect(row.text[0]).toBe('👍🏽');
    expect(row.width[0]).toBe(2);
    expect(row.text[2]).toBe('!');
  });

  it('keeps grapheme clusters on from creation and through a reset (RIS) with the graphemeClusters option', () => {
    const t = VtTerminal.create(instantiate(), 20, 5, { scrollback: 100, colors: theme, graphemeClusters: true });
    const r = RenderState.create(t);
    open.push({ t, r });
    t.write('\x1bc👨‍👩‍👧|');
    r.update();
    const row = frame(r, true).get(0)!.row;
    expect(row.text[0]).toBe('👨‍👩‍👧');
    expect(row.width[0]).toBe(2);
    expect(row.text[2]).toBe('|');
  });

  it('says which rows changed since the last frame, and nothing once it is drawn', () => {
    const { t, r } = make();
    t.write('one\r\ntwo\r\nthree');
    r.update();
    frame(r, true);
    expect(r.update()).toBe('none');
    expect(frame(r).size).toBe(0);
    t.write('\x1b[2;1Hxx');
    expect(r.update()).toBe('partial');
    const rows = frame(r);
    // The row written, and the one the cursor left; not the others.
    expect([...rows.keys()]).toEqual([1, 2]);
    expect(line(rows.get(1)!.text)).toBe('xxo');
  });

  it('reads the cursor: where, its shape and blink, hidden', () => {
    const { t, r } = make();
    t.write('abc\r\nd');
    r.update();
    expect(r.cursor()).toMatchObject({ visible: true, x: 1, y: 1 });
    t.write('\x1b[5 q');
    r.update();
    expect(r.cursor()).toMatchObject({ style: 'bar', blinking: true });
    t.write('\x1b[2 q');
    r.update();
    expect(r.cursor()).toMatchObject({ style: 'block', blinking: false });
    t.write('\x1b[?25l');
    r.update();
    expect(r.cursor().visible).toBe(false);
  });

  it('scrolls the view through the scrollback; new output does not move it; back to the bottom', () => {
    const { t, r } = make(20, 5);
    for (let i = 1; i <= 30; i++) t.write(`line ${i}\r\n`);
    r.update();
    frame(r, true);
    expect(t.viewportActive()).toBe(true);
    t.scrollViewport(-10);
    expect(t.viewportActive()).toBe(false);
    r.update();
    const top = line(frame(r, true).get(0)!.text);
    expect(top).toBe('line 17');
    expect(t.scrollbar()).toMatchObject({ len: 5 });
    t.write('more\r\nand more\r\n');
    r.update();
    expect(line(frame(r, true).get(0)!.text)).toBe(top);
    t.scrollViewport('bottom');
    expect(t.viewportActive()).toBe(true);
    r.update();
    const rows = frame(r, true);
    expect(line(rows.get(3)!.text)).toBe('and more');
  });

  it('takes the colours a program set (OSC 11) and says they changed', () => {
    const { t, r } = make();
    r.update();
    r.colors();
    expect(r.colors().changed).toBe(false);
    t.write('\x1b]11;rgb:10/20/30\x1b\\');
    r.update();
    const c = r.colors();
    expect(c.changed).toBe(true);
    expect(c.colors.background).toBe(0x102030);
  });
});
