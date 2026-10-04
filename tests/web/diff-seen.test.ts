import { describe, expect, it } from 'vitest';
import { fileSignature, newestCheckpoint, sinceLookAvailable } from '../../src/web/src/state/diff-seen.js';
import { viewedFrom } from '../../src/web/src/hooks/use-viewed-files.js';

const file = (content: string, added = 1) => ({
  added,
  deleted: 0,
  hunks: [
    {
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      context: '',
      lines: [{ kind: 'add' as const, content, oldNum: null, newNum: 1 }],
    },
  ],
});

describe('since you looked', () => {
  it('is offered only when a turn finished after the last look', () => {
    const cps = [{ id: 0 }, { id: 1 }, { id: 2 }];
    expect(newestCheckpoint(cps)).toBe(2);
    expect(newestCheckpoint([])).toBeNull();
    expect(sinceLookAvailable({ checkpointId: 1, at: '' }, cps)).toBe(true);
    expect(sinceLookAvailable({ checkpointId: 2, at: '' }, cps)).toBe(false);
    expect(sinceLookAvailable(null, cps)).toBe(false);
  });
});

describe('Viewed ticks follow the change they were given for', () => {
  it('a file changed again is no longer viewed; an older bare tick holds', () => {
    const before = fileSignature(file('a'));
    expect(fileSignature(file('a'))).toBe(before);
    expect(fileSignature(file('b'))).not.toBe(before);
    expect(fileSignature(file('a', 2))).not.toBe(before);
    const keys = new Set([`src/a.ts#${before}`, 'src/legacy.ts']);
    expect([...viewedFrom(keys, new Map([['src/a.ts', before]]))].sort()).toEqual(['src/a.ts', 'src/legacy.ts']);
    expect([...viewedFrom(keys, new Map([['src/a.ts', fileSignature(file('b'))]]))]).toEqual(['src/legacy.ts']);
    // Without signatures (the bare wd page): every tick holds.
    expect([...viewedFrom(keys)].sort()).toEqual(['src/a.ts', 'src/legacy.ts']);
  });
});
