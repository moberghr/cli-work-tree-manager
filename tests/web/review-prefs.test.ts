import { describe, expect, it } from 'vitest';
import { marksKey, readMarks, readRailFolded, toggled, writeMarks, writeRailFolded } from '../../src/web/src/state/review-prefs.js';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('what the Reviews tab remembers per browser', () => {
  it('the rail folded or not; blocked storage forgets quietly', () => {
    const s = memory();
    expect(readRailFolded(s)).toBe(false);
    writeRailFolded(true, s);
    expect(readRailFolded(s)).toBe(true);
    writeRailFolded(false, s);
    expect(readRailFolded(s)).toBe(false);
    expect(readRailFolded(throwing)).toBe(false);
    expect(() => writeRailFolded(true, throwing)).not.toThrow();
  });

  it("a review's marks per head: a new push starts clean; garbage reads as none", () => {
    const s = memory();
    const at = { repo: 'api', number: 231, headSha: 'a1' };
    writeMarks(marksKey('viewed', at), toggled(new Set(), 'src/a.cs', true), s);
    expect([...readMarks(marksKey('viewed', at), s)]).toEqual(['src/a.cs']);
    expect(readMarks(marksKey('viewed', { ...at, headSha: 'b2' }), s).size).toBe(0);
    expect(readMarks(marksKey('looked', at), s).size).toBe(0);
    s.setItem(marksKey('looked', at), '{"no":1}');
    expect(readMarks(marksKey('looked', at), s).size).toBe(0);
    s.setItem(marksKey('looked', at), '["d1", 3]');
    expect([...readMarks(marksKey('looked', at), s)]).toEqual(['d1']);
    expect(readMarks('x', throwing).size).toBe(0);
    expect([...toggled(new Set(['a', 'b']), 'a', false)]).toEqual(['b']);
  });
});
