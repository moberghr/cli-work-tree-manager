import fs from 'node:fs';
import path from 'node:path';

/**
 * Reading TypeScript source for the architecture tests: what is code, what is
 * a comment, what is a string, and what a module loads — whole files, never a
 * line at a time (Prettier wraps a call's arguments over several lines, and a
 * guard reading one line saw none of them: #63 review F002).
 *
 * Not a parser: a small tokenizer that knows comments, strings, template
 * literals (with `${…}` nesting), regex literals (told from division by the
 * token before the slash) and, in a .tsx file, JSX (an element's text and
 * attribute strings, its `{…}` code), which is all these guards need. Imports
 * include a dynamic `import()` with a literal specifier. Its own tests are
 * source-scan.test.ts.
 */

export const ROOT = path.resolve(__dirname, '../..');
export const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

export interface Literal {
  /** A string's or a template chunk's text as written (escapes left as they are). */
  value: string;
  /** 1-based line of its start. */
  line: number;
}

export interface Scanned {
  /** The text with every comment blanked (same length, newlines kept): code, strings and regexes as written. */
  code: string;
  /** Every string literal, and every template literal's text between substitutions. */
  strings: Literal[];
}

const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'yield',
  'await',
  'else',
  'do',
]);

/** Before a `/` (a regex) or a `<` (a JSX element): what can't end a value. */
const STARTS_REGEX = '(,=:[!&|?{};+-*%<>~^';
const STARTS_JSX = '(,=:[!&|?{};>';

/**
 * Comments blanked, strings collected. `jsx` (a .tsx file): JSX is read as JSX — an element's text and its
 * attribute strings are strings (text kept in `code`, so a URL in it is seen), its `{…}` code — not as code,
 * where a `//` in a URL read as a comment and an apostrophe as a string's start that hid the code after it.
 */
export function scan(text: string, opts: { jsx?: boolean } = {}): Scanned {
  const out = text.split('');
  const strings: Literal[] = [];
  const lineAt = (i: number) => text.slice(0, i).split('\n').length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const n = text.length;

  /** Code from `i` to an unmatched `}` (when `inBraces`: a substitution's or a JSX expression's end) or the end; returns where it stopped. */
  const code = (start: number, inBraces: boolean): number => {
    let i = start;
    let depth = 0;
    /** The last significant code character before here (for regex vs division, JSX vs less-than), and the word ending there. */
    let prev = '';
    let prevWord = '';
    while (i < n) {
      const c = text[i];
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        const end = text.indexOf('\n', i);
        const stop = end < 0 ? n : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        strings.push({ value: text.slice(i + 1, j), line: lineAt(i) });
        i = j + 1;
        prev = c;
        prevWord = '';
        continue;
      }
      if (c === '`') {
        i = template(i + 1);
        prev = '`';
        prevWord = '';
        continue;
      }
      const valueEnds = !(prev === '' || KEYWORDS_BEFORE_REGEX.has(prevWord));
      if (c === '/' && (!valueEnds || STARTS_REGEX.includes(prev))) {
        let j = i + 1;
        let inClass = false;
        while (j < n && text[j] !== '\n') {
          const d = text[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(text[j])) j++; // flags
        i = j;
        prev = ')'; // a regex is a value: a slash after it divides
        prevWord = '';
        continue;
      }
      if (opts.jsx && c === '<' && (!valueEnds || STARTS_JSX.includes(prev)) && /[A-Za-z>]/.test(next ?? '')) {
        const end = element(i);
        if (end !== null) {
          i = end;
          prev = ')'; // an element is a value
          prevWord = '';
          continue;
        }
      }
      if (c === '{') depth++;
      else if (c === '}') {
        if (inBraces && depth === 0) return i;
        depth--;
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
        prevWord = text.slice(i, j);
        prev = text[j - 1];
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        prev = c;
        prevWord = '';
      }
      i++;
    }
    return n;
  };

  /** A template literal from just after its opening `: its chunks are strings, its `${…}` code. Returns the index after its closing `. */
  const template = (start: number): number => {
    let j = start;
    let chunk = start;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        strings.push({ value: text.slice(chunk, j), line: lineAt(chunk) });
        return j + 1;
      }
      if (c === '$' && text[j + 1] === '{') {
        strings.push({ value: text.slice(chunk, j), line: lineAt(chunk) });
        j = code(j + 2, true) + 1;
        chunk = j;
        continue;
      }
      j++;
    }
    return n;
  };

  /** A JSX element (or fragment) at its `<`; the index after it, or null when this `<` isn't one (`<T,>` generics). */
  const element = (start: number): number | null => {
    let j = start + 1;
    if (text[j] !== '>') {
      const name = /^[A-Za-z][\w.:-]*/.exec(text.slice(j, j + 200));
      if (!name) return null;
      j += name[0].length;
      if (!/[\s/>{]/.test(text[j] ?? '')) return null; // `<T,>` or `<T extends …`-like: not an element
      // Attributes: strings are strings, `{…}` is code; to `>` or `/>`.
      for (;;) {
        if (j >= n) return n;
        const c = text[j];
        if (c === '{') {
          j = code(j + 1, true) + 1;
          continue;
        }
        if (c === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
          // A comment between attributes (TSX allows them): blanked, as in code.
          const end = text[j + 1] === '/' ? text.indexOf('\n', j) : text.indexOf('*/', j + 2);
          const stop = end < 0 ? n : text[j + 1] === '/' ? end : end + 2;
          blank(j, stop);
          j = stop;
          continue;
        }
        if (c === '"' || c === "'") {
          const end = text.indexOf(c, j + 1);
          const stop = end < 0 ? n : end;
          strings.push({ value: text.slice(j + 1, stop), line: lineAt(j) });
          j = stop + 1;
          continue;
        }
        if (c === '/' && text[j + 1] === '>') return j + 2;
        if (c === '>') break;
        j++;
      }
    }
    j++; // past the opening tag's `>`
    // Children: text (a string), `{…}` code, elements; to the closing tag.
    let run = j;
    const flush = (to: number) => {
      const value = text.slice(run, to);
      if (value.trim()) strings.push({ value: value.trim(), line: lineAt(run + value.length - value.trimStart().length) });
    };
    while (j < n) {
      const c = text[j];
      if (c === '{') {
        flush(j);
        j = code(j + 1, true) + 1;
        run = j;
        continue;
      }
      if (c === '<' && text[j + 1] === '/') {
        flush(j);
        const end = text.indexOf('>', j);
        return end < 0 ? n : end + 1;
      }
      if (c === '<') {
        flush(j);
        j = element(j) ?? j + 1;
        run = j;
        continue;
      }
      j++;
    }
    flush(n);
    return n;
  };

  code(0, false);
  return { code: out.join(''), strings };
}

/** A file's text as `scan` should read it: JSX in a .tsx file. */
export const scanFile = (file: string, text: string) => scan(text, { jsx: file.endsWith('.tsx') });

/** 1-based line of an offset. */
export const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

// Static imports and re-exports, and side-effect imports; `import type` / `export type` are erased.
const IMPORT_RE = /(?:^|\n)\s*(import|export)(\s+type)?\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

// `import('./x.js')` with a literal specifier: a lazy load (`await import(…)`, `import(…).then`) is still a load.
// One read as a type (`typeof import(…)`, `import(…).Name`) is erased.
const DYNAMIC_RE = /(typeof\s+)?(?<![\w$.])import\s*\(\s*(['"`])([^'"`$]+)\2\s*\)(\s*\.\s*(?!then\b|catch\b|finally\b)[A-Za-z_$])?/g;

/**
 * A module's import specifiers (comments ignored): `runtime` ones load it — at start, or lazily by a dynamic
 * `import()` with a literal specifier (what it loads later is still what it reaches) — `types` are erased.
 * `jsx`: the text is a .tsx file's.
 */
export function importsOf(text: string, opts: { jsx?: boolean } = {}): { runtime: string[]; types: string[] } {
  const code = scan(text, opts).code;
  const runtime: string[] = [];
  const types: string[] = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    if (m[4]) runtime.push(m[4]);
    else (m[2] ? types : runtime).push(m[3]!);
  }
  for (const m of code.matchAll(DYNAMIC_RE)) (m[1] || m[4] ? types : runtime).push(m[3]!);
  return { runtime, types };
}

/** A relative specifier from `file` (repo-relative) as the repo-relative `.ts`/`.tsx` file it names; null when none. */
export function resolveLocal(file: string, spec: string): string | null {
  const base = path.resolve(path.dirname(path.join(ROOT, file)), spec).replace(/\.js$/, '');
  const hit = ['.ts', '.tsx', '/index.ts'].map((x) => base + x).find((f) => fs.existsSync(f));
  return hit ? rel(hit) : null;
}

/** Every local file `entries` load, at start or lazily (themselves included), and every package and Node builtin they reach, by who. */
export function loadedBy(
  entries: string[],
  opts: { stopAt?: (file: string) => boolean } = {},
): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (opts.stopAt?.(file)) return;
    for (const spec of importsOf(fs.readFileSync(path.join(ROOT, file), 'utf8'), { jsx: file.endsWith('.tsx') }).runtime) {
      if (!spec.startsWith('.')) {
        if (!packages.has(spec)) packages.set(spec, file);
        continue;
      }
      const hit = resolveLocal(file, spec);
      if (hit) visit(hit);
    }
  };
  for (const e of entries) visit(e);
  return { files, packages };
}

/** Every .ts/.tsx file under a repo-relative folder. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel(p));
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}
