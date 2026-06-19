import { describe, expect, it } from 'vitest';
import { addedLines, inlineRows } from '../../src/web/src/utils/intraline.js';
import type { Hunk } from '../../src/web/src/api/client.js';

function hunk(over: Partial<Hunk>): Hunk {
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 0,
    context: '',
    lines: [],
    ...over,
  };
}

describe('addedLines', () => {
  it('collects all added lines from a single all-add hunk in order', () => {
    const h = hunk({
      newStart: 1,
      newLines: 3,
      lines: [
        { kind: 'add', content: 'one', oldNum: null, newNum: 1 },
        { kind: 'add', content: 'two', oldNum: null, newNum: 2 },
        { kind: 'add', content: 'three', oldNum: null, newNum: 3 },
      ],
    });
    expect(addedLines([h])).toEqual([
      { newNum: 1, content: 'one' },
      { newNum: 2, content: 'two' },
      { newNum: 3, content: 'three' },
    ]);
  });

  it('walks multiple hunks and keeps only add lines, skipping context/delete/no-newline', () => {
    const h1 = hunk({
      lines: [
        { kind: 'context', content: 'ctx', oldNum: 1, newNum: 1 },
        { kind: 'add', content: 'a', oldNum: null, newNum: 2 },
      ],
    });
    const h2 = hunk({
      lines: [
        { kind: 'delete', content: 'gone', oldNum: 5, newNum: null },
        { kind: 'add', content: 'b', oldNum: null, newNum: 6 },
        { kind: 'no-newline', content: '', oldNum: null, newNum: null },
      ],
    });
    expect(addedLines([h1, h2])).toEqual([
      { newNum: 2, content: 'a' },
      { newNum: 6, content: 'b' },
    ]);
  });

  it('returns an empty array when there are no hunks', () => {
    expect(addedLines([])).toEqual([]);
  });
});

describe('inlineRows', () => {
  it('emits context lines in place with both line numbers', () => {
    const h = hunk({
      lines: [
        { kind: 'context', content: 'ctx', oldNum: 10, newNum: 12 },
      ],
    });
    expect(inlineRows(h)).toEqual([
      { kind: 'context', oldNum: 10, newNum: 12, content: 'ctx' },
    ]);
  });

  it('orders a change block as all deletions then all additions (GitHub unified)', () => {
    const h = hunk({
      lines: [
        { kind: 'context', content: 'before', oldNum: 1, newNum: 1 },
        { kind: 'delete', content: 'old-a', oldNum: 2, newNum: null },
        { kind: 'delete', content: 'old-b', oldNum: 3, newNum: null },
        { kind: 'add', content: 'new-a', oldNum: null, newNum: 2 },
        { kind: 'context', content: 'after', oldNum: 4, newNum: 3 },
      ],
    });
    const rows = inlineRows(h);
    expect(rows.map((r) => [r.kind, r.oldNum, r.newNum, r.content])).toEqual([
      ['context', 1, 1, 'before'],
      ['delete', 2, null, 'old-a'],
      ['delete', 3, null, 'old-b'],
      ['add', null, 2, 'new-a'],
      ['context', 4, 3, 'after'],
    ]);
  });

  it('attaches intra-line spans to paired deletion/addition rows', () => {
    const h = hunk({
      lines: [
        { kind: 'delete', content: 'const x = 1;', oldNum: 1, newNum: null },
        { kind: 'add', content: 'const x = 2;', oldNum: null, newNum: 1 },
      ],
    });
    const rows = inlineRows(h);
    const del = rows.find((r) => r.kind === 'delete')!;
    const add = rows.find((r) => r.kind === 'add')!;
    // Both sides carry word-level spans, and each marks exactly the changed token.
    expect(del.spans?.some((s) => s.changed && s.text.includes('1'))).toBe(true);
    expect(add.spans?.some((s) => s.changed && s.text.includes('2'))).toBe(true);
  });

  it('skips no-newline markers', () => {
    const h = hunk({
      lines: [
        { kind: 'add', content: 'only', oldNum: null, newNum: 1 },
        { kind: 'no-newline', content: '', oldNum: null, newNum: null },
      ],
    });
    expect(inlineRows(h)).toEqual([
      { kind: 'add', oldNum: null, newNum: 1, content: 'only', spans: undefined },
    ]);
  });
});
