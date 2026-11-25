import { describe, expect, it } from 'vitest';
import { findPathRefs, joinRows, splitLine } from '../../../src/core/worktree/terminal-path-refs.js';

const raws = (text: string): string[] => findPathRefs(text).map((r) => r.raw);

describe('findPathRefs: the forms of a path', () => {
  it('file:// addresses, percent-encoding allowed', () => {
    expect(raws('open file:///private/tmp/a%20b.html now')).toEqual(['file:///private/tmp/a%20b.html']);
    expect(raws('file:///C:/x/y.ts')).toEqual(['file:///C:/x/y.ts']);
  });

  it('absolute POSIX paths: two segments, or one with an extension; a lone /tmp is prose', () => {
    expect(raws('see /Users/me/dev/a.ts')).toEqual(['/Users/me/dev/a.ts']);
    expect(raws('in /tmp/x')).toEqual(['/tmp/x']);
    expect(raws('a file /a.txt here')).toEqual(['/a.txt']);
    expect(raws('write to /tmp')).toEqual([]);
    expect(raws('a / b')).toEqual([]);
  });

  it('~/ paths', () => {
    expect(raws('edit ~/.work/config.json')).toEqual(['~/.work/config.json']);
    expect(raws('home ~ is')).toEqual([]);
  });

  it('Windows paths with backslashes or slashes', () => {
    expect(raws('open C:\\Users\\me\\a.ts please')).toEqual(['C:\\Users\\me\\a.ts']);
    expect(raws('open C:/a/b now')).toEqual(['C:/a/b']);
  });

  it('relative paths with a separator', () => {
    expect(raws('src/web/x.tsx')).toEqual(['src/web/x.tsx']);
    expect(raws('see ./a/b and ../a/b.ts')).toEqual(['./a/b', '../a/b.ts']);
    expect(raws('the src/web/components folder')).toEqual(['src/web/components']);
  });

  it('bare file names with an extension', () => {
    expect(raws('SessionRail.tsx and package.json')).toEqual(['SessionRail.tsx', 'package.json']);
    expect(raws('run node.js')).toEqual(['node.js']);
  });

  it('keeps :line and :line:col in raw', () => {
    expect(raws('SessionRail.tsx:202')).toEqual(['SessionRail.tsx:202']);
    expect(raws('error in a/b.ts:10:4: bad')).toEqual(['a/b.ts:10:4']);
    expect(raws('/tmp/x/y.ts:7.')).toEqual(['/tmp/x/y.ts:7']);
  });
});

describe('findPathRefs: what is not a path', () => {
  it('web addresses and anything inside one', () => {
    expect(raws('see http://example.com/a/b.html')).toEqual([]);
    expect(raws('see https://github.com/x/y/blob/main/a.ts#L3')).toEqual([]);
    expect(raws('[docs](https://example.com/docs/page.html)')).toEqual([]);
  });

  it('versions, decimals, abbreviations', () => {
    expect(raws('released v2.0.1 and 1.2.3')).toEqual([]);
    expect(raws('2.0.1-dev.3+sha')).toEqual([]);
    expect(raws('pi is 3.14')).toEqual([]);
    expect(raws('use it, e.g. now, i.e. later, in the U.S.')).toEqual([]);
  });

  it('word pairs, dates and fractions', () => {
    expect(raws('and/or input/output w/o it')).toEqual([]);
    expect(raws('on 2026/11/25 add 1/2 cup')).toEqual([]);
  });
});

describe('findPathRefs: punctuation around a path', () => {
  it('trailing punctuation is not part of it', () => {
    expect(raws('see src/a.ts.')).toEqual(['src/a.ts']);
    expect(raws('src/a.ts, src/b.ts; src/c.ts:')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(raws('(file:///x/y.html).')).toEqual(['file:///x/y.html']);
    expect(raws('[src/a.ts] {src/b.ts} <src/c.ts>')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('leading wrappers are not part of it', () => {
    expect(raws('"src/a.ts" \'src/b.ts\' `src/c.ts`')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(raws('(src/a.ts)')).toEqual(['src/a.ts']);
  });

  it('a space ends the path (only %20 stays inside a file:// address)', () => {
    expect(raws('/Users/me/my file.ts')).toEqual(['/Users/me/my', 'file.ts']);
  });

  it('several paths in one line, with their offsets', () => {
    const text = 'diff (a/b.ts:10:4), `src/web/x.tsx` and file:///tmp/a%20b.html.';
    const refs = findPathRefs(text);
    expect(refs.map((r) => r.raw)).toEqual(['a/b.ts:10:4', 'src/web/x.tsx', 'file:///tmp/a%20b.html']);
    for (const r of refs) expect(text.slice(r.start, r.end)).toBe(r.raw);
  });
});

describe('splitLine', () => {
  it('splits :line and :line:col off', () => {
    expect(splitLine('a/b.ts:10:4')).toEqual({ path: 'a/b.ts', line: 10 });
    expect(splitLine('a/b.ts:10')).toEqual({ path: 'a/b.ts', line: 10 });
    expect(splitLine('a/b.ts')).toEqual({ path: 'a/b.ts' });
  });

  it('keeps the drive colon of a Windows path', () => {
    expect(splitLine('C:\\x\\y.ts:3')).toEqual({ path: 'C:\\x\\y.ts', line: 3 });
    expect(splitLine('C:\\x\\y.ts')).toEqual({ path: 'C:\\x\\y.ts' });
  });

  it('decodes a file:// address to a plain path', () => {
    expect(splitLine('file:///private/tmp/a%20b.html')).toEqual({ path: '/private/tmp/a b.html' });
    expect(splitLine('file:///C:/x/y.ts')).toEqual({ path: 'C:/x/y.ts' });
    expect(splitLine('file:///tmp/a.ts:12')).toEqual({ path: '/tmp/a.ts', line: 12 });
  });

  it('does not throw on a malformed percent sequence', () => {
    expect(splitLine('file:///tmp/100%.html')).toEqual({ path: '/tmp/100%.html' });
  });

  it('line 0 or a non-numeric suffix is not a line', () => {
    expect(splitLine('a.ts:0')).toEqual({ path: 'a.ts' });
    expect(splitLine('a.ts:abc')).toEqual({ path: 'a.ts:abc' });
  });
});

describe('joinRows', () => {
  it('joins a soft-wrapped row as it is', () => {
    const j = joinRows([{ text: 'src/web/comp' }, { text: 'onents/x.tsx', wrapped: true }], 80);
    expect(j.text).toBe('src/web/components/x.tsx');
    expect(j.rows).toBe(2);
  });

  it('joins a hard wrap and drops the indent of the continuation', () => {
    const row1 = '(file:///private/tmp/claude-502/-Users-me-Dev-worktrees-work-tree-session-start-u';
    const row2 = '  i/7584/scratchpad/session-rail-designs.html).';
    const cols = row1.length;
    const j = joinRows([{ text: row1 }, { text: row2 }], cols);
    expect(j.rows).toBe(2);
    expect(j.text).toBe(row1 + 'i/7584/scratchpad/session-rail-designs.html).');
    const refs = findPathRefs(j.text);
    expect(refs).toHaveLength(1);
    expect(refs[0].raw).toBe(
      'file:///private/tmp/claude-502/-Users-me-Dev-worktrees-work-tree-session-start-ui/7584/scratchpad/session-rail-designs.html',
    );
  });

  it('does not join a row that is not full', () => {
    const j = joinRows([{ text: 'src/a.ts' }, { text: '  next line' }], 80);
    expect(j.text).toBe('src/a.ts');
    expect(j.rows).toBe(1);
  });

  it('does not hard-join onto an empty row', () => {
    const full = 'x'.repeat(20);
    const j = joinRows([{ text: full }, { text: '' }], 20);
    expect(j.rows).toBe(1);
  });

  it('never joins more than 8 rows', () => {
    const rows = Array.from({ length: 12 }, () => ({ text: 'abcd', wrapped: true }));
    rows[0].wrapped = false;
    const j = joinRows(rows, 4);
    expect(j.rows).toBe(8);
    expect(j.text).toBe('abcd'.repeat(8));
  });

  it('says where each character came from, skipping a dropped indent', () => {
    const j = joinRows([{ text: 'abc' }, { text: '  de' }], 4);
    expect(j.text).toBe('abcde');
    expect(j.map).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 2 },
      { row: 1, col: 3 },
    ]);
  });

  it('handles no rows', () => {
    expect(joinRows([], 80)).toEqual({ text: '', map: [], rows: 0 });
  });
});
