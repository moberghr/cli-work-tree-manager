import { STYLE, type RowCells, type Underline } from '../../../../../core/pty/ghostty/render-state.js';
import type { KeyInput } from '../../../../../core/pty/ghostty/key-encoder.js';

/**
 * The ghostty engine's drawing and keyboard rules, pure (ghostty-engine.ts paints and listens): a row of cells as the
 * runs a canvas draws — backgrounds first, then text by style, box and block characters as shapes — and a
 * KeyboardEvent as libghostty's key encoder wants it.
 */

/** A stretch of cells with one background that isn't the default. */
export interface BgRun {
  x: number;
  cells: number;
  color: number;
}

/** Text placed at a cell: several narrow characters drawn as one string (the font's advance is the cell's), else one. */
export interface Piece {
  x: number;
  text: string;
  /** Cells it covers (2 for a wide character). */
  cells: number;
}

/** Cells with one look: their text, and the lines drawn with it. */
export interface TextRun {
  color: number;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  underline: Underline;
  /** -1: the text's colour. */
  underlineColor: number;
  strike: boolean;
  overline: boolean;
  /** First cell and cells covered (the lines go under all of them, blanks included). */
  x: number;
  cells: number;
  pieces: Piece[];
}

/** A box-drawing or block character, drawn as shapes to fill its cell (box-shape below). */
export interface BoxGlyph {
  x: number;
  cp: number;
  color: number;
  faint: boolean;
}

export interface RowRuns {
  bgs: BgRun[];
  texts: TextRun[];
  boxes: BoxGlyph[];
}

/** Box drawing (U+2500–U+257F) and block elements (U+2580–U+259F): drawn, not taken from the font, so they join. */
export const isBoxChar = (cp: number): boolean => cp >= 0x2500 && cp <= 0x259f;

/** Characters the main font has at exactly one cell's advance: drawn together. Anything else is placed on its own. */
const simple = (s: string): boolean => s.length === 1 && s.charCodeAt(0) >= 0x20 && s.charCodeAt(0) < 0x2000;

/**
 * What a row draws, with `defaults` for cells that set no colour. Inverse swaps the two colours (defaults included);
 * invisible text is not drawn (its background is).
 */
export function rowRuns(row: RowCells, defaults: { fg: number; bg: number }): RowRuns {
  const bgs: BgRun[] = [];
  const texts: TextRun[] = [];
  const boxes: BoxGlyph[] = [];
  let run: TextRun | null = null;
  for (let x = 0; x < row.cols; x++) {
    const flags = row.flags[x]!;
    let fg = row.fg[x] === -1 ? defaults.fg : row.fg[x]!;
    let bg = row.bg[x]!;
    if (flags & STYLE.INVERSE) {
      const was = fg;
      fg = bg === -1 ? defaults.bg : bg;
      bg = was;
    }
    if (bg !== -1 && bg !== defaults.bg) {
      const last = bgs[bgs.length - 1];
      if (last && last.color === bg && last.x + last.cells === x) last.cells++;
      else bgs.push({ x, cells: 1, color: bg });
    }
    const width = row.width[x]!;
    if (width === 0) continue; // the second half of a wide character: drawn with the first
    const text = flags & STYLE.INVISIBLE ? '' : row.text[x]!;
    const underline = row.underline[x]! as Underline;
    const strike = (flags & STYLE.STRIKE) !== 0;
    const overline = (flags & STYLE.OVERLINE) !== 0;
    const cp = text.codePointAt(0) ?? 0;
    if (text.length && isBoxChar(cp) && text.length === 1) {
      boxes.push({ x, cp, color: fg, faint: (flags & STYLE.FAINT) !== 0 });
      if (!underline && !strike && !overline) {
        run = null;
        continue;
      }
    }
    const lines = underline !== 0 || strike || overline;
    if (!text && !lines) {
      run = null;
      continue;
    }
    const look = {
      color: fg,
      bold: (flags & STYLE.BOLD) !== 0,
      italic: (flags & STYLE.ITALIC) !== 0,
      faint: (flags & STYLE.FAINT) !== 0,
      underline,
      underlineColor: row.ul[x]!,
      strike,
      overline,
    };
    if (
      !run ||
      run.x + run.cells !== x ||
      run.color !== look.color ||
      run.bold !== look.bold ||
      run.italic !== look.italic ||
      run.faint !== look.faint ||
      run.underline !== look.underline ||
      run.underlineColor !== look.underlineColor ||
      run.strike !== look.strike ||
      run.overline !== look.overline
    ) {
      run = { ...look, x, cells: 0, pieces: [] };
      texts.push(run);
    }
    run.cells += width;
    if (!text || isBoxChar(cp)) continue;
    const last = run.pieces[run.pieces.length - 1];
    if (last && width === 1 && simple(text) && simple(last.text.slice(-1)) && last.x + last.cells === x) {
      last.text += text;
      last.cells++;
    } else run.pieces.push({ x, text, cells: width });
  }
  return { bgs, texts, boxes };
}

// ---- box drawing ----------------------------------------------------------------------------------------------------

/**
 * U+2500–U+257F: each character's four arms, up, right, down, left — 0 none, 1 light, 2 heavy, 3 double — or a
 * letter: `h`/`v` a dashed line (its weight and dash count follow), `a` a rounded corner, `x` a diagonal.
 */
const BOX: readonly string[] = [
  '0101',
  '0202',
  '1010',
  '2020',
  'h13',
  'h23',
  'v13',
  'v23',
  'h14',
  'h24',
  'v14',
  'v24',
  '0110',
  '0210',
  '0120',
  '0220',
  '0011',
  '0012',
  '0021',
  '0022',
  '1100',
  '1200',
  '2100',
  '2200',
  '1001',
  '1002',
  '2001',
  '2002',
  '1110',
  '1210',
  '2110',
  '1120',
  '2120',
  '2210',
  '1220',
  '2220',
  '1011',
  '1012',
  '2011',
  '1021',
  '2021',
  '2012',
  '1022',
  '2022',
  '0111',
  '0112',
  '0211',
  '0212',
  '0121',
  '0122',
  '0221',
  '0222',
  '1101',
  '1102',
  '1201',
  '1202',
  '2101',
  '2102',
  '2201',
  '2202',
  '1111',
  '1112',
  '1211',
  '1212',
  '2111',
  '1121',
  '2121',
  '2112',
  '2211',
  '1122',
  '1221',
  '2212',
  '1222',
  '2122',
  '2221',
  '2222',
  'h12',
  'h22',
  'v12',
  'v22',
  '0303',
  '3030',
  '0310',
  '0130',
  '0330',
  '0013',
  '0031',
  '0033',
  '1300',
  '3100',
  '3300',
  '1003',
  '3001',
  '3003',
  '1310',
  '3130',
  '3330',
  '1013',
  '3031',
  '3033',
  '0313',
  '0131',
  '0333',
  '1303',
  '3101',
  '3303',
  '1313',
  '3131',
  '3333',
  'a0110',
  'a0011',
  'a1001',
  'a1100',
  'x1',
  'x2',
  'x3',
  '0001',
  '1000',
  '0100',
  '0010',
  '0002',
  '2000',
  '0200',
  '0020',
  '0201',
  '1020',
  '0102',
  '2010',
];

/** Device-pixel shapes for one cell: rectangles to fill, and lines to stroke (with a control point: a curve). */
export interface BoxShape {
  rects: [number, number, number, number][];
  strokes: { from: [number, number]; to: [number, number]; via?: [number, number] }[];
  lineWidth: number;
  /** The shades (░ ▒ ▓): drawn at this opacity. */
  alpha: number;
}

/** The shape of `cp` in a `w` × `h` cell, its light lines `light` thick; null when it isn't one drawn here. */
export function boxShape(cp: number, w: number, h: number, light: number): BoxShape | null {
  const shape: BoxShape = { rects: [], strokes: [], lineWidth: light, alpha: 1 };
  const heavy = light * 2;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  if (cp >= 0x2580 && cp <= 0x259f) return blockShape(cp, w, h, shape);
  const spec = BOX[cp - 0x2500];
  if (!spec) return null;
  const kind = spec[0]!;
  if (kind === 'h' || kind === 'v') {
    const t = spec[1] === '2' ? heavy : light;
    const n = Number(spec[2]);
    const along = kind === 'h' ? w : h;
    const step = along / n;
    const dash = Math.max(1, Math.round(step * 0.6));
    for (let i = 0; i < n; i++) {
      const at = Math.round(i * step);
      if (kind === 'h') shape.rects.push([at, cy - Math.floor(t / 2), dash, t]);
      else shape.rects.push([cx - Math.floor(t / 2), at, t, dash]);
    }
    return shape;
  }
  if (kind === 'a') {
    // Its vertical arm goes up or down, its horizontal one left or right: a curve between them through the centre.
    const [up, , , left] = [...spec.slice(1)].map(Number);
    const x = cx + 0.5 * (light % 2);
    const y = cy + 0.5 * (light % 2);
    const from: [number, number] = up ? [x, 0] : [x, h];
    const to: [number, number] = left ? [0, y] : [w, y];
    shape.strokes.push({ from, to, via: [x, y] });
    return shape;
  }
  if (kind === 'x') {
    const n = Number(spec[1]);
    if (n & 1) shape.strokes.push({ from: [w, 0], to: [0, h] });
    if (n & 2) shape.strokes.push({ from: [0, 0], to: [w, h] });
    return shape;
  }
  const arms = [...spec].map(Number);
  const gap = Math.max(light, Math.round(light * 1.5));
  // How wide the joint is each way: an arm reaches across the crossing ones (a double one is both its lines and the gap).
  const thick = (a: number) => (a === 2 ? heavy : a === 3 ? 2 * gap + light : a ? light : 0);
  const across = Math.max(thick(arms[0]!), thick(arms[2]!)) || light;
  const along = Math.max(thick(arms[1]!), thick(arms[3]!)) || light;
  arms.forEach((a, i) => {
    if (!a) return;
    const t = a === 2 ? heavy : light;
    for (const o of a === 3 ? [-gap, gap] : [0]) {
      const vx = cx + o - Math.floor(t / 2);
      const hy = cy + o - Math.floor(t / 2);
      if (i === 0) shape.rects.push([vx, 0, t, cy + Math.ceil(along / 2)]);
      if (i === 2) shape.rects.push([vx, cy - Math.floor(along / 2), t, h - cy + Math.floor(along / 2)]);
      if (i === 1) shape.rects.push([cx - Math.floor(across / 2), hy, w - cx + Math.floor(across / 2), t]);
      if (i === 3) shape.rects.push([0, hy, cx + Math.ceil(across / 2), t]);
    }
  });
  return shape;
}

/** U+2580–U+259F: eighths, halves, quadrants and shades. */
function blockShape(cp: number, w: number, h: number, shape: BoxShape): BoxShape {
  const rect = (x0: number, y0: number, x1: number, y1: number) =>
    shape.rects.push([
      Math.round(x0 * w),
      Math.round(y0 * h),
      Math.round(x1 * w) - Math.round(x0 * w),
      Math.round(y1 * h) - Math.round(y0 * h),
    ]);
  if (cp === 0x2580) rect(0, 0, 1, 0.5);
  else if (cp >= 0x2581 && cp <= 0x2588) rect(0, 1 - (cp - 0x2580) / 8, 1, 1);
  else if (cp >= 0x2589 && cp <= 0x258f) rect(0, 0, (8 - (cp - 0x2588)) / 8, 1);
  else if (cp === 0x2590) rect(0.5, 0, 1, 1);
  else if (cp >= 0x2591 && cp <= 0x2593) {
    rect(0, 0, 1, 1);
    shape.alpha = (cp - 0x2590) / 4;
  } else if (cp === 0x2594) rect(0, 0, 1, 1 / 8);
  else if (cp === 0x2595) rect(7 / 8, 0, 1, 1);
  else {
    // Quadrants, as bits: upper left 1, upper right 2, lower left 4, lower right 8.
    const QUADRANTS = [4, 8, 1, 1 | 4 | 8, 1 | 8, 1 | 2 | 4, 1 | 2 | 8, 2, 2 | 4, 2 | 4 | 8];
    const q = QUADRANTS[cp - 0x2596] ?? 0;
    if (q & 1) rect(0, 0, 0.5, 0.5);
    if (q & 2) rect(0.5, 0, 1, 0.5);
    if (q & 4) rect(0, 0.5, 0.5, 1);
    if (q & 8) rect(0.5, 0.5, 1, 1);
  }
  return shape;
}

// ---- the keyboard ---------------------------------------------------------------------------------------------------

/** What US keys type without Shift: kitty's alternate keys name a key by it. */
const UNSHIFTED: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Space: ' ',
  IntlBackslash: '\\',
};

/** The parts of a KeyboardEvent the encoder needs. */
export type KeyEventLike = Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat'>;

/**
 * A browser key event as libghostty's key encoder wants it. `text` is what the key types (`e.key` when it is one
 * character); on a Mac, Option composing a character (`å`) has spent Alt on it, as xterm.js does by default
 * (macOptionIsMeta off), so the character is sent and not ESC + `a`.
 */
export function keyInput(e: KeyEventLike, mac: boolean, action: 'press' | 'release' = 'press'): KeyInput {
  const text = [...e.key].length === 1 ? e.key : '';
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit(\d)$/.exec(e.code);
  const base = letter ? letter[1]!.toLowerCase() : digit ? digit[1]! : (UNSHIFTED[e.code] ?? (!e.shiftKey && text ? text : ''));
  const unshifted = base.codePointAt(0) ?? 0;
  const lowered = text.toLowerCase();
  const composedByOption = mac && e.altKey && !!text && lowered !== base && !e.ctrlKey;
  return {
    code: e.code,
    text,
    unshifted,
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
    consumed: { shift: e.shiftKey && !!text && text !== base, alt: composedByOption },
    action: action === 'release' ? 'release' : e.repeat ? 'repeat' : 'press',
  };
}
