/**
 * Renders an xterm-headless buffer into an array of ANSI-styled strings (one per row).
 * No cursor positioning — just SGR codes + text, suitable for Ink <Text> components.
 *
 * SGR utility functions are copied from src/tui/renderer.ts.
 */

interface CellAttrs {
  fgMode: number;
  fg: number;
  bgMode: number;
  bg: number;
  bold: number;
  dim: number;
  italic: number;
  underline: number;
  blink: number;
  inverse: number;
  invisible: number;
  strikethrough: number;
  overline: number;
}

function readAttrs(cell: any): CellAttrs {
  return {
    fgMode: cell.getFgColorMode(),
    fg: cell.getFgColor(),
    bgMode: cell.getBgColorMode(),
    bg: cell.getBgColor(),
    bold: cell.isBold(),
    dim: cell.isDim(),
    italic: cell.isItalic(),
    underline: cell.isUnderline(),
    blink: cell.isBlink(),
    inverse: cell.isInverse(),
    invisible: cell.isInvisible(),
    strikethrough: cell.isStrikethrough(),
    overline: cell.isOverline(),
  };
}

function attrsEqual(a: CellAttrs, b: CellAttrs): boolean {
  return (
    a.fgMode === b.fgMode &&
    a.fg === b.fg &&
    a.bgMode === b.bgMode &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.invisible === b.invisible &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline
  );
}

function attrsToSgr(a: CellAttrs): string {
  if (
    a.fgMode === 0 &&
    a.bgMode === 0 &&
    !a.bold && !a.dim && !a.italic && !a.underline &&
    !a.blink && !a.inverse && !a.invisible && !a.strikethrough && !a.overline
  ) {
    return '\x1B[0m';
  }

  const params: number[] = [0];
  if (a.bold) params.push(1);
  if (a.dim) params.push(2);
  if (a.italic) params.push(3);
  if (a.underline) params.push(4);
  if (a.blink) params.push(5);
  if (a.inverse) params.push(7);
  if (a.invisible) params.push(8);
  if (a.strikethrough) params.push(9);
  if (a.overline) params.push(53);

  pushColorSgr(params, a.fgMode, a.fg, false);
  pushColorSgr(params, a.bgMode, a.bg, true);

  return `\x1B[${params.join(';')}m`;
}

function pushColorSgr(params: number[], mode: number, color: number, isBg: boolean): void {
  const CM_DEFAULT = 0;
  const CM_P16 = 0x1000000;
  const CM_P256 = 0x2000000;
  const CM_RGB = 0x3000000;

  if (mode === CM_DEFAULT) return;

  const base = isBg ? 40 : 30;

  if (mode === CM_P16 || mode === CM_P256) {
    if (color < 8) {
      params.push(base + color);
    } else if (color < 16) {
      params.push(base + 60 + (color - 8));
    } else {
      params.push(base + 8, 5, color);
    }
  } else if (mode === CM_RGB) {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    params.push(base + 8, 2, r, g, b);
  }
}

/**
 * Render the visible portion of an xterm buffer as an array of ANSI-styled lines.
 * @param scrollBack - number of lines scrolled back from the bottom (0 = live view)
 */
export function renderBufferLines(buffer: any, cols: number, rows: number, scrollBack: number = 0): string[] {
  const lines: string[] = [];
  const nullCell = buffer.getNullCell();

  for (let y = 0; y < rows; y++) {
    const lineIdx = buffer.baseY + y - scrollBack;
    const line = buffer.getLine(lineIdx);
    let prevAttrs: CellAttrs | null = null;

    if (!line) {
      lines.push(' '.repeat(cols));
      continue;
    }

    const parts: string[] = [];
    parts.push('\x1B[0m');

    let col = 0;
    while (col < cols) {
      const cell = line.getCell(col, nullCell);
      if (!cell) {
        parts.push(' ');
        col++;
        continue;
      }

      const width = cell.getWidth();
      if (width === 0) {
        col++;
        continue;
      }

      const attrs = readAttrs(cell);
      if (!prevAttrs || !attrsEqual(prevAttrs, attrs)) {
        parts.push(attrsToSgr(attrs));
        prevAttrs = attrs;
      }

      const ch = cell.getChars();
      parts.push(ch || ' ');
      col += width;
    }

    parts.push('\x1B[0m');
    lines.push(parts.join(''));
  }

  return lines;
}
