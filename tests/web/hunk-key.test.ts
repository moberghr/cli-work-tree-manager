import { describe, expect, it } from 'vitest';
import type { Hunk, HunkLine } from '../../src/web/src/api/client.js';
import { hunkContentKey } from '../../src/web/src/utils/hunk-key.js';

function line(
  kind: HunkLine['kind'],
  content: string,
  oldNum: number | null,
  newNum: number | null,
): HunkLine {
  return { kind, content, oldNum, newNum };
}

function hunk(partial: Partial<Hunk> & { lines: HunkLine[] }): Hunk {
  return {
    oldStart: 1,
    oldLines: partial.lines.length,
    newStart: 1,
    newLines: partial.lines.length,
    context: '',
    ...partial,
  };
}

describe('hunkContentKey', () => {
  const body: HunkLine[] = [
    line('context', 'const a = 1;', 10, 10),
    line('delete', 'const b = 2;', 11, null),
    line('add', 'const b = 3;', null, 11),
  ];

  it('prefixes the file path and is deterministic', () => {
    const h = hunk({ lines: body });
    const k1 = hunkContentKey('src/foo.ts', h);
    const k2 = hunkContentKey('src/foo.ts', h);
    expect(k1).toBe(k2);
    expect(k1.startsWith('src/foo.ts@')).toBe(true);
  });

  it('is STABLE when line numbers drift but the body is unchanged', () => {
    // chokidar live-reload: an unrelated edit above shifts this hunk's
    // oldStart/newStart, but the reviewer checked off the same change.
    const before = hunk({ ...{ oldStart: 11, newStart: 11 }, lines: body });
    const after = hunk({ ...{ oldStart: 87, newStart: 91 }, lines: body });
    expect(hunkContentKey('src/foo.ts', after)).toBe(
      hunkContentKey('src/foo.ts', before),
    );
  });

  it('CHANGES when the hunk body content changes', () => {
    const a = hunk({ lines: body });
    const b = hunk({
      lines: [
        line('context', 'const a = 1;', 10, 10),
        line('delete', 'const b = 2;', 11, null),
        line('add', 'const b = 99;', null, 11), // different added content
      ],
    });
    expect(hunkContentKey('src/foo.ts', a)).not.toBe(
      hunkContentKey('src/foo.ts', b),
    );
  });

  it('CHANGES when a line kind changes even with identical text', () => {
    const a = hunk({ lines: [line('add', 'x', null, 1)] });
    const b = hunk({ lines: [line('delete', 'x', 1, null)] });
    expect(hunkContentKey('src/foo.ts', a)).not.toBe(
      hunkContentKey('src/foo.ts', b),
    );
  });

  it('CHANGES when the file path differs', () => {
    const h = hunk({ lines: body });
    expect(hunkContentKey('src/foo.ts', h)).not.toBe(
      hunkContentKey('src/bar.ts', h),
    );
  });

  it('distinguishes hunks whose bodies differ only in line order', () => {
    const a = hunk({
      lines: [line('add', 'one', null, 1), line('add', 'two', null, 2)],
    });
    const b = hunk({
      lines: [line('add', 'two', null, 1), line('add', 'one', null, 2)],
    });
    expect(hunkContentKey('src/foo.ts', a)).not.toBe(
      hunkContentKey('src/foo.ts', b),
    );
  });
});
