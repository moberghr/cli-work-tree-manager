import type { RowCells } from '../../../../../core/pty/ghostty/render-state.js';

/**
 * The pointer over the ghostty engine's canvas, the pure part: which cell a position is in, which mouse button a DOM
 * button is, and the web address under a cell (xterm.js's WebLinksAddon rule). The engine wires these to libghostty's
 * selection gestures, mouse encoder and OSC 8 links (core/pty/ghostty/pointer.ts, mouse-encoder.ts).
 */

/** The cell under a position in device pixels, clamped into the grid (a drag past an edge stays on its last row or column). */
export function gridCell(px: number, py: number, cw: number, ch: number, cols: number, rows: number): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return { x: clamp(Math.floor(px / cw), cols - 1), y: clamp(Math.floor(py / ch), rows - 1) };
}

/** A DOM MouseEvent.button as libghostty's GhosttyMouseButton: left 1, middle 3, right 2, back/forward 8/9; 0 for none. */
export function mouseButton(domButton: number): number {
  return [1, 3, 2, 8, 9][domButton] ?? 0;
}

/** The button a held-buttons mask (MouseEvent.buttons) reports a move with: the first held, as xterm does; 0 when none. */
export function heldButton(buttons: number): number {
  if (buttons & 1) return 1;
  if (buttons & 4) return 3;
  if (buttons & 2) return 2;
  return 0;
}

/** The wheel as mouse buttons: 4 up, 5 down, 6 left, 7 right. */
export function wheelButton(lines: number, horizontal = false): number {
  if (horizontal) return lines < 0 ? 6 : 7;
  return lines < 0 ? 4 : 5;
}

/** xterm.js's WebLinksAddon: a web address in the text of the terminal's lines (its regex, as the addon has it). */
const URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;

/** The addon's check that a match is an address: it parses, and its text starts with what the parse says its origin is. */
export function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const auth = url.password && url.username ? `${url.username}:${url.password}@` : url.username ? `${url.username}@` : '';
    return text.toLowerCase().startsWith(`${url.protocol}//${auth}${url.host}`.toLowerCase());
  } catch {
    return false;
  }
}

/** A link on the screen: where it goes, and its cells row by row (`x0`..`x1` inclusive). */
export interface LinkSpan {
  uri: string;
  cells: Array<{ y: number; x0: number; x1: number }>;
}

type Row = Pick<RowCells, 'cols' | 'text' | 'width' | 'wrapped'>;

/**
 * The web address under a view cell, if any: the cell's whole line (rows the terminal wrapped joined, as the addon reads
 * them) searched for addresses, and the one covering the cell kept.
 */
export function urlAt(rows: ReadonlyArray<Row | undefined>, at: { x: number; y: number }): LinkSpan | null {
  if (!rows[at.y]) return null;
  let first = at.y;
  while (first > 0 && rows[first - 1]?.wrapped) first--;
  let last = at.y;
  while (rows[last]?.wrapped && rows[last + 1]) last++;
  // The line's text, and for each of its UTF-16 units the cell it came from.
  let text = '';
  const ys: number[] = [];
  const xs: number[] = [];
  for (let y = first; y <= last; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.cols; x++) {
      if (row.width[x] === 0) continue;
      const ch = row.text[x] || ' ';
      text += ch;
      for (let i = 0; i < ch.length; i++) {
        ys.push(y);
        xs.push(x);
      }
    }
  }
  // The last column a unit's cell covers (a wide character's two).
  const lastX = (i: number) => xs[i]! + Math.max(0, (rows[ys[i]!]!.width[xs[i]!] ?? 1) - 1);
  const before = (i: number) => ys[i]! < at.y || (ys[i] === at.y && xs[i]! <= at.x);
  const reaches = (i: number) => ys[i]! > at.y || (ys[i] === at.y && lastX(i) >= at.x);
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    const end = start + m[0].length - 1;
    if (!before(start) || !reaches(end) || !isUrl(m[0])) continue;
    const cells: LinkSpan['cells'] = [];
    for (let y = ys[start]!; y <= ys[end]!; y++) {
      cells.push({ y, x0: y === ys[start] ? xs[start]! : 0, x1: y === ys[end] ? lastX(end) : rows[y]!.cols - 1 });
    }
    return { uri: m[0], cells };
  }
  return null;
}

/** The cells of the OSC 8 link at `at` in its row: the run of link cells around it. */
export function linkRun(row: Pick<RowCells, 'cols' | 'link'>, x: number): { x0: number; x1: number } | null {
  if (!row.link[x]) return null;
  let x0 = x;
  while (x0 > 0 && row.link[x0 - 1]) x0--;
  let x1 = x;
  while (x1 < row.cols - 1 && row.link[x1 + 1]) x1++;
  return { x0, x1 };
}
