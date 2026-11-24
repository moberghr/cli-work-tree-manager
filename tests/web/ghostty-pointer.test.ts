import { describe, expect, it } from 'vitest';
import {
  gridCell,
  heldButton,
  isUrl,
  linkRun,
  mouseButton,
  urlAt,
  wheelButton,
} from '../../src/web/src/components/Terminal/engine/ghostty-pointer.js';

/** Rows as the render state gives them: `|` ends a row the terminal wrapped, a wide character takes a tail cell. */
function rows(cols: number, ...lines: string[]) {
  return lines.map((l) => {
    const wrapped = l.endsWith('|');
    const text: string[] = [];
    const width: number[] = [];
    for (const ch of wrapped ? l.slice(0, -1) : l) {
      const wide = /\p{Extended_Pictographic}|[一-鿿]/u.test(ch);
      text.push(ch);
      width.push(wide ? 2 : 1);
      if (wide) {
        text.push('');
        width.push(0);
      }
    }
    while (text.length < cols) {
      text.push('');
      width.push(1);
    }
    return { cols, text, width: Uint8Array.from(width), wrapped };
  });
}

describe('gridCell', () => {
  it('is the cell a device-pixel position falls in, clamped into the grid', () => {
    expect(gridCell(0, 0, 10, 20, 80, 24)).toEqual({ x: 0, y: 0 });
    expect(gridCell(19.9, 39.9, 10, 20, 80, 24)).toEqual({ x: 1, y: 1 });
    expect(gridCell(20, 40, 10, 20, 80, 24)).toEqual({ x: 2, y: 2 });
    expect(gridCell(-30, -5, 10, 20, 80, 24)).toEqual({ x: 0, y: 0 });
    expect(gridCell(5000, 5000, 10, 20, 80, 24)).toEqual({ x: 79, y: 23 });
  });
});

describe('mouse buttons', () => {
  it('maps DOM buttons to the encoder’s, held buttons to the one a move reports, the wheel to 4–7', () => {
    expect([0, 1, 2, 3, 4, 7].map(mouseButton)).toEqual([1, 3, 2, 8, 9, 0]);
    expect(heldButton(0)).toBe(0);
    expect(heldButton(1)).toBe(1);
    expect(heldButton(2)).toBe(2);
    expect(heldButton(4)).toBe(3);
    expect(heldButton(1 | 2)).toBe(1);
    expect(wheelButton(-3)).toBe(4);
    expect(wheelButton(2)).toBe(5);
    expect(wheelButton(-1, true)).toBe(6);
    expect(wheelButton(1, true)).toBe(7);
  });
});

describe('urlAt (WebLinksAddon’s rule)', () => {
  it('finds the address under the cell, without the punctuation after it', () => {
    const r = rows(40, 'see https://example.com/a?b=1, then', 'none here');
    const hit = urlAt(r, { x: 10, y: 0 });
    expect(hit).toEqual({ uri: 'https://example.com/a?b=1', cells: [{ y: 0, x0: 4, x1: 28 }] });
    expect(urlAt(r, { x: 29, y: 0 })).toBeNull();
    expect(urlAt(r, { x: 3, y: 0 })).toBeNull();
    expect(urlAt(r, { x: 2, y: 1 })).toBeNull();
  });

  it('follows an address the terminal wrapped onto the next row, from either row', () => {
    const r = rows(12, 'go http://ex|', 'ample.com/x ok');
    const want = {
      uri: 'http://example.com/x',
      cells: [
        { y: 0, x0: 3, x1: 11 },
        { y: 1, x0: 0, x1: 10 },
      ],
    };
    expect(urlAt(r, { x: 5, y: 0 })).toEqual(want);
    expect(urlAt(r, { x: 2, y: 1 })).toEqual(want);
    expect(urlAt(r, { x: 12, y: 1 })).toBeNull();
  });

  it('keeps cells right after a wide character', () => {
    const r = rows(30, '漢 https://a.io/x');
    expect(urlAt(r, { x: 4, y: 0 })).toEqual({ uri: 'https://a.io/x', cells: [{ y: 0, x0: 3, x1: 16 }] });
  });

  it('takes only what parses as an address', () => {
    expect(isUrl('https://example.com/a')).toBe(true);
    expect(isUrl('http://user:pw@example.com/')).toBe(true);
    expect(isUrl('https://exa mple.com')).toBe(false);
    expect(urlAt(rows(20, 'http://[::1'), { x: 3, y: 0 })).toBeNull();
  });
});

describe('linkRun', () => {
  it('is the run of OSC 8 cells around a cell', () => {
    const link = Uint8Array.from([0, 1, 1, 1, 0, 1]);
    expect(linkRun({ cols: 6, link }, 2)).toEqual({ x0: 1, x1: 3 });
    expect(linkRun({ cols: 6, link }, 5)).toEqual({ x0: 5, x1: 5 });
    expect(linkRun({ cols: 6, link }, 0)).toBeNull();
  });
});
