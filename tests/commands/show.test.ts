import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { showBody, splitFileLine } from '../../src/commands/show.js';

/** `work show`: a file, or the session's Diff / Review / Code, beside its terminal (asked for: a diff next to the conversation). */
describe('splitFileLine', () => {
  it('a line after the name (a column after it too), the name alone otherwise; a drive letter is no line', () => {
    expect(splitFileLine('src/a.ts:12')).toEqual({ file: 'src/a.ts', line: 12 });
    expect(splitFileLine('src/a.ts:12:5')).toEqual({ file: 'src/a.ts', line: 12 });
    expect(splitFileLine('src/a.ts')).toEqual({ file: 'src/a.ts' });
    expect(splitFileLine('src/a.ts:x')).toEqual({ file: 'src/a.ts:x' });
    expect(splitFileLine('C:12')).toEqual({ file: 'C:12' });
    expect(splitFileLine('C:\\w\\a.ts:7')).toEqual({ file: 'C:\\w\\a.ts', line: 7 });
  });
});

describe('showBody', () => {
  const cwd = '/w/feat';
  it('a file by its absolute path; --close; --diff and --review alone', () => {
    expect(showBody({ file: 'docs/spec.md' }, cwd)).toEqual({ file: path.resolve(cwd, 'docs/spec.md') });
    expect(showBody({ close: true }, cwd)).toEqual({ close: true });
    expect(showBody({ diff: true }, cwd)).toEqual({ view: 'diff' });
    expect(showBody({ review: true }, cwd)).toEqual({ view: 'review' });
  });

  it('--code, at a file and line when given', () => {
    expect(showBody({ code: true }, cwd)).toEqual({ view: 'code' });
    expect(showBody({ code: true, file: 'src/a.ts:40' }, cwd)).toEqual({ view: 'code', file: path.resolve(cwd, 'src/a.ts'), line: 40 });
    expect(showBody({ code: true, file: '/abs/b.ts' }, cwd)).toEqual({ view: 'code', file: path.resolve(cwd, '/abs/b.ts') });
  });

  it('says what is wrong: nothing asked, two asked, a file with --diff', () => {
    expect(showBody({}, cwd)).toMatch(/^Usage: work show/);
    expect(showBody({ diff: true, review: true }, cwd)).toMatch(/one of/);
    expect(showBody({ diff: true, close: true }, cwd)).toMatch(/one of/);
    expect(showBody({ diff: true, file: 'a.ts' }, cwd)).toBe('--diff takes no file.');
  });
});
