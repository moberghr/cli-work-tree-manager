import { describe, expect, it } from 'vitest';
import { threadCodeLines } from '../../src/web/src/state/pr-tab.js';

describe('threadCodeLines: the code a review thread is on', () => {
  const hunk = '@@ -1,6 +1,7 @@ class A\n a1\n a2\n a3\n-b\n+c\n+d\n a4\n\\ No newline at end of file\n';

  it('numbers each line in its file (old for removed, new otherwise) and marks the commented ones (the last)', () => {
    const { lines, skipped } = threadCodeLines({ hunk, lines: 2 }, 2);
    expect(skipped).toBe(3);
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text, l.commented])).toEqual([
      ['del', 4, null, 'b', false],
      ['add', null, 4, 'c', false],
      ['add', null, 5, 'd', true],
      ['ctx', 5, 6, 'a4', true],
    ]);
  });

  it('a range longer than the hunk marks it all; a header it cannot read numbers from 0', () => {
    expect(threadCodeLines({ hunk, lines: 99 }).lines.every((l) => l.commented)).toBe(true);
    expect(threadCodeLines({ hunk: '@@ weird @@\n x', lines: 1 }).lines).toEqual([
      { kind: 'ctx', oldNo: 0, newNo: 0, text: 'x', commented: true },
    ]);
  });
});
