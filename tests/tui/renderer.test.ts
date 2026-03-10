import { describe, it, expect } from 'vitest';
import { renderBufferLines } from '../../src/tui-ink/renderer-lines.js';

/** Minimal mock of an xterm IBufferCell. */
function makeCell(ch: string, width = 1) {
  return {
    getChars: () => ch,
    getWidth: () => width,
    getFgColorMode: () => 0,
    getFgColor: () => 0,
    getBgColorMode: () => 0,
    getBgColor: () => 0,
    isBold: () => 0,
    isDim: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
  };
}

function makeLine(chars: string) {
  const cells = [...chars].map((ch) => makeCell(ch));
  return {
    getCell: (col: number, _nullCell: any) => (col < cells.length ? cells[col] : makeCell('')),
  };
}

function makeBuffer(lines: string[], cursorX = 0, cursorY = 0) {
  const lineObjs = lines.map((l) => makeLine(l));
  return {
    baseY: 0,
    cursorX,
    cursorY,
    getLine: (idx: number) => (idx < lineObjs.length ? lineObjs[idx] : null),
    getNullCell: () => makeCell(''),
  };
}

describe('renderBufferLines', () => {
  it('renders a simple buffer as line array', () => {
    const buffer = makeBuffer(['AB', 'CD']);
    const lines = renderBufferLines(buffer, 2, 2);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('A');
    expect(lines[0]).toContain('B');
    expect(lines[1]).toContain('C');
    expect(lines[1]).toContain('D');
  });

  it('fills empty lines with spaces', () => {
    const buffer = makeBuffer([]);
    const lines = renderBufferLines(buffer, 3, 2);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('   ');
    expect(lines[1]).toBe('   ');
  });

  it('returns correct number of lines', () => {
    const buffer = makeBuffer(['x']);
    const lines = renderBufferLines(buffer, 1, 5);

    expect(lines).toHaveLength(5);
  });

  it('resets attributes at end of each line', () => {
    const buffer = makeBuffer(['x']);
    const lines = renderBufferLines(buffer, 1, 1);

    expect(lines[0]).toMatch(/\x1B\[0m$/);
  });

  it('does not contain cursor positioning sequences', () => {
    const buffer = makeBuffer(['hi'], 1, 0);
    const lines = renderBufferLines(buffer, 2, 1);

    // No \x1B[row;colH sequences
    for (const line of lines) {
      expect(line).not.toMatch(/\x1B\[\d+;\d+H/);
    }
  });
});
