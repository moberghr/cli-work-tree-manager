import { describe, expect, it } from 'vitest';
import { addedLines } from '../../src/web/src/utils/intraline.js';
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
