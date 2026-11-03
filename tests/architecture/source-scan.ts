import fs from 'node:fs';
import path from 'node:path';

/**
 * Reading TypeScript source for the architecture tests: what is code, what is
 * a comment, what is a string, and what a module loads — whole files, never a
 * line at a time (Prettier wraps a call's arguments over several lines, and a
 * guard reading one line saw none of them: #63 review F002).
 *
 * Not a parser: a small tokenizer that knows comments, strings, template
 * literals (with `${…}` nesting) and regex literals (told from division by the
 * token before the slash), which is all these guards need. Its own tests are
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

/** Comments blanked, strings collected. */
export function scan(text: string): Scanned {
  const out = text.split('');
  const strings: Literal[] = [];
  const lineAt = (i: number) => text.slice(0, i).split('\n').length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  /** Brace depth at which each open template's `${` started: a `}` at that depth goes back into the template. */
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  /** The last significant code character before here (for regex vs division), and the word ending there. */
  let prev = '';
  let prevWord = '';
  const n = text.length;

  const readTemplate = (start: number) => {
    // From just after ` (or after the } closing a substitution) to the closing ` or the next ${.
    let j = start;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        strings.push({ value: text.slice(start, j), line: lineAt(start) });
        return { end: j + 1, open: false };
      }
      if (c === '$' && text[j + 1] === '{') {
        strings.push({ value: text.slice(start, j), line: lineAt(start) });
        return { end: j + 2, open: true };
      }
      j++;
    }
    return { end: n, open: false };
  };

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
      const t = readTemplate(i + 1);
      if (t.open) templates.push(depth);
      i = t.end;
      prev = '`';
      prevWord = '';
      continue;
    }
    if (c === '}' && templates.length && templates[templates.length - 1] === depth) {
      templates.pop();
      const t = readTemplate(i + 1);
      if (t.open) templates.push(depth);
      i = t.end;
      prev = '`';
      prevWord = '';
      continue;
    }
    if (c === '/') {
      const regexHere = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || KEYWORDS_BEFORE_REGEX.has(prevWord);
      if (regexHere) {
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
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
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
  return { code: out.join(''), strings };
}

/** 1-based line of an offset. */
export const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;

// Static imports and re-exports, and side-effect imports; `import type` / `export type` are erased.
const IMPORT_RE = /(?:^|\n)\s*(import|export)(\s+type)?\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** A module's import specifiers (comments ignored): `runtime` ones load it at start, `types` are erased. */
export function importsOf(text: string): { runtime: string[]; types: string[] } {
  const code = scan(text).code;
  const runtime: string[] = [];
  const types: string[] = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    if (m[4]) runtime.push(m[4]);
    else (m[2] ? types : runtime).push(m[3]!);
  }
  return { runtime, types };
}

/** A relative specifier from `file` (repo-relative) as the repo-relative `.ts`/`.tsx` file it names; null when none. */
export function resolveLocal(file: string, spec: string): string | null {
  const base = path.resolve(path.dirname(path.join(ROOT, file)), spec).replace(/\.js$/, '');
  const hit = ['.ts', '.tsx', '/index.ts'].map((x) => base + x).find((f) => fs.existsSync(f));
  return hit ? rel(hit) : null;
}

/** Every local file `entries` load at start (themselves included), and every package and Node builtin they reach, by who. */
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
    for (const spec of importsOf(fs.readFileSync(path.join(ROOT, file), 'utf8')).runtime) {
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
