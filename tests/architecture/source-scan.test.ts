import { describe, expect, it } from 'vitest';
import { computedImports, importsOf, loadedBy, scan } from './source-scan.js';

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

describe('dynamic import() (#63 re-review N007)', () => {
  it('a lazy import with a literal specifier loads; one read as a type is erased; a computed one is not followed', () => {
    const text = [
      "const m = await import('./lazy.js');",
      'void import("./then.js").then((x) => x);',
      'const t = await import(`./tpl.js`);',
      "type T = typeof import('./typeof.js');",
      "let u: import('./named.js').Name;",
      'const v = await import(name);',
      "// await import('./gone.js');",
      "obj.import('./method.js');",
    ].join('\n');
    expect(importsOf(text)).toEqual({ runtime: ['./lazy.js', './then.js', './tpl.js'], types: ['./typeof.js', './named.js'] });
  });

  it('computedImports names every import() whose specifier is not a literal, by line; strings and comments are not code (S2)', () => {
    const text = [
      "const m = await import('./lazy.js');",
      'const v = await import(name);',
      'const w = await import(`./x/${name}.js`);',
      "const s = 'not import(code)';",
      '// await import(gone);',
      'obj.import(thing);',
      "type T = typeof import('./typeof.js');",
      'const u = import (\n  spec);',
    ].join('\n');
    expect(computedImports(text)).toEqual([2, 3, 8]);
    expect(computedImports('const a = <p>import(x) is prose</p>;', { jsx: true })).toEqual([]);
  });

  it('the walks follow it: what a module loads later is still what it reaches', () => {
    // `work <verb>` loads only that verb, by import() (cli.ts's COMMANDS): the walk reaches the verbs.
    const { files } = loadedBy(['src/cli.ts']);
    expect(files.has('src/commands/tree.ts')).toBe(true);
  });
});

describe('JSX in a .tsx file (#63 re-review N008)', () => {
  it("an element's text is text: a URL in it isn't a comment, an apostrophe doesn't hide the code after it", () => {
    const text = [
      'const a = <p>See https://example.com/x for more</p>;',
      "const b = <p>Don't stop</p>; const c = run('after');",
      'const d = <A href="https://example.org/y" on={() => go(\'inner\')}>hi {name} there<B x={1} /></A>;',
      'const e = <>frag text</>;',
    ].join('\n');
    const { code, strings } = scan(text, { jsx: true });
    expect(code).toContain('https://example.com/x'); // was blanked from `//` as a comment
    expect(strings.map((s) => s.value)).toEqual([
      'See https://example.com/x for more',
      "Don't stop",
      'after', // was hidden: the apostrophe read as a string's start
      'https://example.org/y',
      'inner',
      'hi',
      'there',
      'frag text',
    ]);
  });

  it('a comment between attributes is a comment (its apostrophe starts nothing)', () => {
    const text = "const a = (\n  <input\n    // it's focused first\n    value={v} /* don't */\n  />\n);\nrun('after');";
    const { code, strings } = scan(text, { jsx: true });
    expect(code).not.toContain('focused');
    expect(strings.map((s) => s.value)).toEqual(['after']);
  });

  it("a comparison and a generic aren't elements", () => {
    const { strings } = scan("const x = a < b ? 'y' : 'n';\nfunction f<T>(v: T) { return 'z'; }\nconst g = <T,>(v: T) => 'w';", {
      jsx: true,
    });
    expect(strings.map((s) => s.value)).toEqual(['y', 'n', 'z', 'w']);
  });

  it("an arrow's `<T extends X>` generic isn't an element: the code after it stays code (#63 S1)", () => {
    const text = "const g = <T extends object>(v: T) => 'w';\nrun('gh', []);\nconst h = <K extends keyof T,>(k: K) => k;\nrun('az');";
    const { strings, code } = scan(text, { jsx: true });
    expect(strings.map((s) => s.value)).toEqual(['w', 'gh', 'az']);
    expect(code).toContain("run('gh', [])");
    // An element whose first attribute is named something else is still an element.
    expect(scan("const e = <Foo extendsX='a'>t</Foo>;", { jsx: true }).strings.map((s) => s.value)).toEqual(['a', 't']);
  });

  it('without jsx (a .ts file) the text is code, as before', () => {
    expect(scan("const s = 'a'; // c\n").code).toBe("const s = 'a';     \n");
  });
});
