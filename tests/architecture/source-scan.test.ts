import { describe, expect, it } from 'vitest';
import { importsOf, loadedBy, scan } from './source-scan.js';

/** The architecture guards' reader: a guard that misreads source can't fail (#63 review F002, F004, F007). */

describe('scan', () => {
  it('blanks comments only, keeping offsets and lines; strings and regexes stay', () => {
    const text = "const a = '/* not a comment */'; // gone\nconst r = /\\/\\*x/; /* gone\ntoo */ const b = 1;";
    const { code, strings } = scan(text);
    expect(code.length).toBe(text.length);
    expect(code.split('\n')).toHaveLength(3);
    expect(code).toContain("'/* not a comment */'");
    expect(code).toContain('/\\/\\*x/');
    expect(code).not.toContain('gone');
    expect(code).toContain('const b = 1;');
    expect(strings.map((s) => [s.value, s.line])).toEqual([['/* not a comment */', 1]]);
  });

  it("template chunks are strings, their substitutions code (nested ones too); division isn't a regex", () => {
    const { strings } = scan("const t = `a ${f({ x: 'in' })} b ${`deep ${'z'}`} c`;\nconst d = x / 2 / y; const s = 'after';");
    expect(strings.map((s) => s.value)).toEqual(['a ', 'in', ' b ', 'deep ', 'z', '', ' c', 'after']);
  });
});

describe('importsOf / loadedBy', () => {
  it('static, re-exported and side-effect imports load; type-only and commented-out ones do not', () => {
    const text = [
      "import a from './a.js';",
      "import { type T, b } from './b.js';",
      "import type { U } from './u.js';",
      "export { c } from './c.js';",
      "export type { V } from './v.js';",
      "import './side.js';",
      "// import { gone } from './gone.js';",
      "/* import x from 'x'; */",
      'import {',
      '  d,',
      "} from 'pkg';",
    ].join('\n');
    expect(importsOf(text)).toEqual({ runtime: ['./a.js', './b.js', './c.js', './side.js', 'pkg'], types: ['./u.js', './v.js'] });
  });

  it('follows imports past the first level, and stops where told', () => {
    const all = loadedBy(['src/core/hosts/commands.ts']);
    expect(all.files.has('src/core/hosts/github/commands.ts')).toBe(true);
    const deep = loadedBy(['src/core/pr/pr-watch-hosts.ts']);
    expect(deep.files.has('src/core/platform/db.ts') || deep.packages.has('node:fs')).toBe(true);
    const stopped = loadedBy(['src/core/pr/pr-watch-hosts.ts'], { stopAt: (f) => f === 'src/core/pr/pr-watch-hosts.ts' });
    expect([...stopped.files]).toEqual(['src/core/pr/pr-watch-hosts.ts']);
  });
});
