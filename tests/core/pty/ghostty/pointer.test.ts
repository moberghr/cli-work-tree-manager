import { afterEach, describe, expect, it } from 'vitest';
import { instantiate } from '../../../../src/core/pty/ghostty/wasm.js';
import { VtTerminal } from '../../../../src/core/pty/ghostty/vt-terminal.js';
import { RenderState, type RowCells } from '../../../../src/core/pty/ghostty/render-state.js';
import {
  SelectionGesture,
  clearSelection,
  extendSelection,
  hasSelection,
  hyperlinkAt,
  selectedText,
  selectionBounds,
} from '../../../../src/core/pty/ghostty/pointer.js';
import { MouseEncoder, type MouseInput } from '../../../../src/core/pty/ghostty/mouse-encoder.js';

let open: { free(): void }[] = [];
afterEach(() => {
  for (const o of open.reverse()) o.free();
  open = [];
});

function make(cols = 20, rows = 5) {
  const t = VtTerminal.create(instantiate(), cols, rows, { scrollback: 100, graphemeClusters: true });
  const s = SelectionGesture.create(t);
  open.push(t, s);
  return { t, s };
}

/** A pointer over a cell of a grid of 10×20 pixel cells, a little into it. */
const at = (x: number, y: number) => ({ cell: { x, y }, px: x * 10 + 2, py: y * 20 + 5 });
const geom = { cols: 20, cellWidth: 10, paddingLeft: 0, height: 100 };

function rows(t: VtTerminal): Map<number, Pick<RowCells, 'selStart' | 'selEnd' | 'wrapped'> & { link: number[] }> {
  const r = RenderState.create(t);
  try {
    r.update();
    r.colors();
    const out = new Map<number, Pick<RowCells, 'selStart' | 'selEnd' | 'wrapped'> & { link: number[] }>();
    r.eachRow(true, (y, row) =>
      out.set(y, { selStart: row.selStart, selEnd: row.selEnd, wrapped: row.wrapped, link: Array.from(row.link) }),
    );
    return out;
  } finally {
    r.free();
  }
}

describe('selection gestures', () => {
  it('a drag selects from the press to the pointer, across a wrapped line, and copies it as one line', () => {
    const { t, s } = make();
    t.write('hello world foo bar baz qux\r\nnext');
    s.press(at(2, 0), 1000);
    expect(hasSelection(t)).toBe(false);
    s.drag(at(5, 1), geom);
    s.release(at(5, 1));
    expect(s.dragged()).toBe(true);
    // The pointer is in the left half of column 5: the selection ends before it.
    expect(selectionBounds(t)).toEqual({ start: { x: 2, y: 0 }, end: { x: 4, y: 1 } });
    expect(selectedText(t)).toMatchObject({ text: 'llo world foo bar baz q', startX: 2 });
    const r = rows(t);
    expect(r.get(0)).toMatchObject({ selStart: 2, selEnd: 19, wrapped: true });
    expect(r.get(1)).toMatchObject({ selStart: 0, selEnd: 4, wrapped: false });
    expect(r.get(2)).toMatchObject({ selStart: -1, selEnd: -1 });
  });

  it('a double click selects a word, a triple click the whole (wrapped) line, a single click clears it', () => {
    const { t, s } = make();
    t.write('hello world foo bar baz qux');
    s.press(at(1, 1), 5000);
    s.release(at(1, 1));
    s.press(at(1, 1), 5100);
    expect(s.clicks()).toBe(2);
    expect(selectedText(t)?.text).toBe('baz');
    s.release(at(1, 1));
    s.press(at(1, 1), 5200);
    expect(s.clicks()).toBe(3);
    expect(selectedText(t)?.text).toBe('hello world foo bar baz qux');
    s.release(at(1, 1));
    s.press(at(3, 3), 9000);
    expect(hasSelection(t)).toBe(false);
  });

  it('presses far apart in time are single clicks', () => {
    const { t, s } = make();
    t.write('hello world');
    s.press(at(1, 0), 1000);
    s.release(at(1, 0));
    s.press(at(1, 0), 3000);
    expect(s.clicks()).toBe(1);
    expect(hasSelection(t)).toBe(false);
  });

  it('shift+click moves the nearer end: the end after the start, the start before it', () => {
    const { t, s } = make();
    t.write('one two three four');
    s.press(at(4, 0), 1000);
    s.drag(at(7, 0), geom);
    s.release(at(7, 0));
    expect(selectedText(t)?.text).toBe('two');
    expect(extendSelection(t, { x: 12, y: 0 })).toBe(true);
    expect(selectedText(t)?.text).toBe('two three');
    expect(extendSelection(t, { x: 0, y: 0 })).toBe(true);
    expect(selectedText(t)?.text).toBe('one two three');
    clearSelection(t);
    expect(hasSelection(t)).toBe(false);
    expect(extendSelection(t, { x: 3, y: 0 })).toBe(false);
  });

  it('a drag past the top or bottom edge asks to autoscroll; a tick scrolls the view and carries the selection on', () => {
    const { t, s } = make();
    for (let i = 1; i <= 30; i++) t.write(`line ${i}\r\n`);
    s.press(at(0, 2), 1000);
    s.drag({ cell: { x: 3, y: 0 }, px: 30, py: -15 }, geom);
    expect(s.autoscroll()).toBe('up');
    const before = selectionBounds(t)!;
    s.tick({ cell: { x: 3, y: 0 }, px: 30, py: -15 }, geom);
    expect(t.viewportActive()).toBe(false);
    expect(selectionBounds(t)!.start.y).toBe(before.start.y - 1);
    s.drag({ cell: { x: 3, y: 4 }, px: 30, py: 130 }, geom);
    expect(s.autoscroll()).toBe('down');
    s.release(null);
  });

  it('reads the selection with its styles for a rich copy', () => {
    const { t, s } = make();
    t.write('a \x1b[1mbold\x1b[0m z');
    s.press(at(0, 0), 1000);
    s.drag(at(8, 0), geom);
    const sel = selectedText(t)!;
    expect(sel.text).toBe('a bold z');
    expect(sel.vt).toContain('\x1b[');
    expect(sel.vt.replace(/\x1b\[[0-9;:]*m/g, '')).toBe('a bold z');
  });
});

describe('links', () => {
  it('reads an OSC 8 link under a cell, nothing off it; the render state marks its cells', () => {
    const { t } = make();
    t.write('see \x1b]8;;https://example.com/a?b=1\x1b\\here\x1b]8;;\x1b\\ now');
    expect(hyperlinkAt(t, { x: 4, y: 0 })).toBe('https://example.com/a?b=1');
    expect(hyperlinkAt(t, { x: 7, y: 0 })).toBe('https://example.com/a?b=1');
    expect(hyperlinkAt(t, { x: 8, y: 0 })).toBe('');
    expect(hyperlinkAt(t, { x: 0, y: 0 })).toBe('');
    expect(rows(t).get(0)!.link.slice(0, 10)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 0, 0]);
  });

  it('reads a link longer than the scratch area', () => {
    const { t } = make();
    const uri = `https://example.com/${'x'.repeat(1500)}`;
    t.write(`\x1b]8;;${uri}\x1b\\L\x1b]8;;\x1b\\`);
    expect(hyperlinkAt(t, { x: 0, y: 0 })).toBe(uri);
  });
});

describe('MouseEncoder', () => {
  function mouse(cols = 20, rows = 5) {
    const { t } = make(cols, rows);
    const m = MouseEncoder.create(t);
    open.push(m);
    m.resize({ width: 200 + 14, height: 100, cellWidth: 10, cellHeight: 20, paddingRight: 14, paddingBottom: 0 });
    return { t, m };
  }
  const input = (o: Partial<MouseInput>): MouseInput => ({
    action: 'press',
    button: 1,
    shift: false,
    ctrl: false,
    alt: false,
    meta: false,
    x: 0,
    y: 0,
    ...o,
  });

  it('sends nothing while no program asked for the mouse', () => {
    const { m } = mouse();
    expect(m.encode(input({ x: 15, y: 25 }), true)).toBe('');
  });

  it('reports presses and releases in SGR (1000 + 1006), at the cell under the pointer, with modifiers', () => {
    const { t, m } = mouse();
    t.write('\x1b[?1000h\x1b[?1006h');
    expect(m.encode(input({ x: 15, y: 25 }), true)).toBe('\x1b[<0;2;2M');
    expect(m.encode(input({ action: 'release', x: 15, y: 25 }), false)).toBe('\x1b[<0;2;2m');
    expect(m.encode(input({ button: 3, ctrl: true, x: 0, y: 0 }), true)).toBe('\x1b[<17;1;1M');
    // Moves aren't asked for in 1000.
    expect(m.encode(input({ action: 'motion', button: 1, x: 55, y: 25 }), true)).toBe('');
  });

  it('reports a drag in 1002 once per cell, and the wheel as buttons 4 and 5', () => {
    const { t, m } = mouse();
    t.write('\x1b[?1002h\x1b[?1006h');
    expect(m.encode(input({ action: 'motion', x: 55, y: 25 }), true)).toBe('\x1b[<32;6;2M');
    expect(m.encode(input({ action: 'motion', x: 57, y: 25 }), true)).toBe('');
    expect(m.encode(input({ button: 4, x: 5, y: 5 }), false)).toBe('\x1b[<64;1;1M');
    expect(m.encode(input({ button: 5, x: 5, y: 5 }), false)).toBe('\x1b[<65;1;1M');
  });

  it('reports pixels in 1016, and the X10 format when no other was asked for', () => {
    const { t, m } = mouse();
    t.write('\x1b[?1000h\x1b[?1016h');
    expect(m.encode(input({ x: 15, y: 25 }), true)).toBe('\x1b[<0;15;25M');
    t.write('\x1b[?1016l');
    expect(m.encode(input({ x: 15, y: 25 }), true)).toBe('\x1b[M ""');
  });
});
