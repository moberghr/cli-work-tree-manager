import { describe, expect, it } from 'vitest';
import { boxShape, keyInput, rowRuns, type KeyEventLike } from '../../src/web/src/components/Terminal/engine/ghostty-draw.js';
import { STYLE, type RowCells } from '../../src/core/pty/ghostty/render-state.js';

const FG = 0xcccccc;
const BG = 0x1e1e1e;

/** A row from cells given as [text, width?, {fg, bg, flags, underline, ul}?]. */
function row(
  cells: Array<[string, number?, Partial<{ fg: number; bg: number; flags: number; underline: number; ul: number }>?]>,
): RowCells {
  const n = cells.length;
  const r: RowCells = {
    cols: n,
    text: cells.map((c) => c[0]),
    width: Uint8Array.from(cells.map((c) => c[1] ?? 1)),
    fg: Int32Array.from(cells.map((c) => c[2]?.fg ?? -1)),
    bg: Int32Array.from(cells.map((c) => c[2]?.bg ?? -1)),
    ul: Int32Array.from(cells.map((c) => c[2]?.ul ?? -1)),
    flags: Uint16Array.from(cells.map((c) => c[2]?.flags ?? 0)),
    underline: Uint8Array.from(cells.map((c) => c[2]?.underline ?? 0)),
  };
  return r;
}
const text = (s: string, style?: Parameters<typeof row>[0][number][2]) =>
  [...s].map((ch) => [ch, 1, style] as [string, number, typeof style]);

describe('rowRuns: a row as the canvas draws it', () => {
  it('one text run for same-styled text, simple characters merged into one piece placed by cell', () => {
    const r = rowRuns(row(text('ls -la')), { fg: FG, bg: BG });
    expect(r.bgs).toEqual([]);
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0]).toMatchObject({ x: 0, cells: 6, color: FG, bold: false });
    expect(r.texts[0]!.pieces).toEqual([{ x: 0, text: 'ls -la', cells: 6 }]);
    // An empty cell (nothing written there) ends the run; text after it starts another.
    const gap = rowRuns(row([...text('ab'), [''], ...text('c')]), { fg: FG, bg: BG });
    expect(gap.texts.map((t) => t.pieces.map((p) => [p.x, p.text]))).toEqual([[[0, 'ab']], [[3, 'c']]]);
  });

  it('a new run where the style changes; backgrounds as runs of their own, the default background left out', () => {
    const r = rowRuns(row([...text('ab', { fg: 0xff0000, bg: 0x0000ff }), ...text('c', { flags: STYLE.BOLD }), ['', 1, { bg: BG }]]), {
      fg: FG,
      bg: BG,
    });
    expect(r.bgs).toEqual([{ x: 0, cells: 2, color: 0x0000ff }]);
    expect(r.texts.map((t) => [t.x, t.cells, t.color, t.bold])).toEqual([
      [0, 2, 0xff0000, false],
      [2, 1, FG, true],
    ]);
  });

  it('inverse swaps the colours, defaults included; invisible text keeps its background and draws nothing', () => {
    const r = rowRuns(row([...text('x', { flags: STYLE.INVERSE }), ...text('y', { flags: STYLE.INVISIBLE, bg: 0x00ff00 })]), {
      fg: FG,
      bg: BG,
    });
    expect(r.bgs).toEqual([
      { x: 0, cells: 1, color: FG },
      { x: 1, cells: 1, color: 0x00ff00 },
    ]);
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0]).toMatchObject({ x: 0, color: BG });
  });

  it('a wide character is one piece over two cells; graphemes stay whole; its spacer draws nothing', () => {
    const r = rowRuns(
      row([
        ['界', 2],
        ['', 0],
        ['👍🏽', 2],
        ['', 0],
        ['a', 1],
      ]),
      { fg: FG, bg: BG },
    );
    expect(r.texts[0]!.pieces).toEqual([
      { x: 0, text: '界', cells: 2 },
      { x: 2, text: '👍🏽', cells: 2 },
      { x: 4, text: 'a', cells: 1 },
    ]);
    expect(r.texts[0]!.cells).toBe(5);
  });

  it('box and block characters are shapes, not text; underlines and their colour carried on the run', () => {
    const r = rowRuns(row([['─'], ['█'], ...text('u', { underline: 3, ul: 0xff00ff })]), { fg: FG, bg: BG });
    expect(r.boxes.map((b) => [b.x, b.cp])).toEqual([
      [0, 0x2500],
      [1, 0x2588],
    ]);
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0]).toMatchObject({ x: 2, underline: 3, underlineColor: 0xff00ff });
  });
});

describe('boxShape: box drawing and blocks drawn to the cell', () => {
  const covers = (rects: [number, number, number, number][], px: number, py: number) =>
    rects.some(([x, y, w, h]) => px >= x && px < x + w && py >= y && py < y + h);

  it('─ is a 1-pixel line across the whole cell at its middle, nothing above or below', () => {
    const { rects } = boxShape(0x2500, 8, 16, 1)!;
    expect([0, 1, 2, 3, 4, 5, 6, 7].every((x) => covers(rects, x, 8))).toBe(true);
    expect(covers(rects, 4, 7) || covers(rects, 4, 9)).toBe(false);
  });

  it('┼ reaches every edge; ═ is two lines with a gap between', () => {
    const cross = boxShape(0x253c, 8, 16, 1)!.rects;
    expect([covers(cross, 0, 8), covers(cross, 7, 8), covers(cross, 4, 0), covers(cross, 4, 15)]).toEqual([true, true, true, true]);
    const double = boxShape(0x2550, 8, 16, 1)!.rects;
    const ys = new Set(double.map(([, y]) => y));
    expect(ys.size).toBe(2);
    expect(covers(double, 0, 8)).toBe(false);
  });

  it('█ fills the cell, ▀ its top half, ░ is a shade', () => {
    expect(boxShape(0x2588, 8, 16, 1)!.rects).toEqual([[0, 0, 8, 16]]);
    expect(boxShape(0x2580, 8, 16, 1)!.rects).toEqual([[0, 0, 8, 8]]);
    expect(boxShape(0x2591, 8, 16, 1)!.alpha).toBeLessThan(1);
  });

  it('╭ is an arc (a curve, not rectangles); outside the range there is no shape', () => {
    expect(boxShape(0x256d, 8, 16, 1)!.strokes.some((s) => s.via)).toBe(true);
    expect(boxShape(0x41, 8, 16, 1)).toBeNull();
  });
});

describe('keyInput: a browser key as the key encoder wants it', () => {
  const ev = (e: Partial<KeyEventLike>): KeyEventLike => ({
    code: '',
    key: '',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...e,
  });

  it('a letter: its text and unshifted key; Shift spent on the capital', () => {
    expect(keyInput(ev({ code: 'KeyA', key: 'a' }), false)).toMatchObject({ code: 'KeyA', text: 'a', unshifted: 0x61, action: 'press' });
    expect(keyInput(ev({ code: 'KeyA', key: 'A', shiftKey: true }), false).consumed).toEqual({ shift: true, alt: false });
  });

  it('a named key has no text; a held key repeats; a release says so', () => {
    expect(keyInput(ev({ code: 'ArrowUp', key: 'ArrowUp' }), false)).toMatchObject({ text: '', unshifted: 0 });
    expect(keyInput(ev({ code: 'KeyB', key: 'b', repeat: true }), false).action).toBe('repeat');
    expect(keyInput(ev({ code: 'KeyB', key: 'b' }), false, 'release').action).toBe('release');
  });

  it('on a Mac, Option composing a character spends Alt on it; Alt+letter elsewhere stays Alt', () => {
    expect(keyInput(ev({ code: 'KeyA', key: 'å', altKey: true }), true).consumed?.alt).toBe(true);
    expect(keyInput(ev({ code: 'KeyA', key: 'a', altKey: true }), false).consumed?.alt).toBe(false);
  });

  it('the unshifted key of a symbol is its key cap, not what Shift made', () => {
    expect(keyInput(ev({ code: 'Digit1', key: '!', shiftKey: true }), false)).toMatchObject({ text: '!', unshifted: 0x31 });
    expect(keyInput(ev({ code: 'Slash', key: '?', shiftKey: true }), false)).toMatchObject({ text: '?', unshifted: 0x2f });
  });
});
