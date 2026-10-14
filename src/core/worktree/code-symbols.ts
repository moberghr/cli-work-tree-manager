import type { CodeSymbol, CodeSymbolKind } from '../api-types.js';

/**
 * The pure half of code search (code-search.ts runs git): reading git grep's
 * lines, the declaration patterns, and matching names as Visual Studio's
 * Ctrl+T does. The demo uses these over its made-up files.
 */

/** A matching line longer than this is cut (minified files). */
export const MAX_LINE_CHARS = 240;

/** `path:line:text` as git grep -n prints it (a Windows path has no `:` once git made it relative). */
export function parseGrepLine(line: string): { path: string; line: number; text: string } | null {
  // With -z: `path\0line\0text`, the path verbatim (a colon or a non-ASCII letter in it is fine).
  const z = /^([^\0]+)\0(\d+)\0(.*)$/.exec(line);
  if (z) return { path: z[1], line: Number(z[2]), text: z[3] };
  const m = /^(.+?):(\d+):(.*)$/.exec(line);
  return m ? { path: m[1], line: Number(m[2]), text: m[3] } : null;
}

/** Smart case, as VS Code: all lower case means any case. */
export const ignoresCase = (q: string) => q === q.toLowerCase();

const MODS =
  '(?:(?:public|private|protected|internal|static|sealed|abstract|partial|async|override|virtual|readonly|new|extern|unsafe|required|file)\\s+)*';
/** Each language's declarations: a line's kind and name. Checked in order; the first that matches wins. */
const RULES: Array<{ ext: RegExp; re: RegExp; kind: (m: RegExpExecArray) => CodeSymbolKind; name: (m: RegExpExecArray) => string }> = [
  // C#: types, then methods and properties (a member needs an access modifier, so a call isn't one).
  {
    ext: /\.(cs|cshtml|razor)$/i,
    re: new RegExp(`^\\s*${MODS}(class|record\\s+struct|record|struct|interface|enum)\\s+([A-Za-z_]\\w*)`),
    kind: (m) => (m[1].startsWith('record') ? 'record' : (m[1] as CodeSymbolKind)),
    name: (m) => m[2],
  },
  {
    ext: /\.(cs|cshtml|razor)$/i,
    re: new RegExp(`^\\s*(?:public|private|protected|internal)\\s+${MODS}[\\w<>\\[\\],.?() ]+?\\s+([A-Za-z_]\\w*)\\s*(?:<[^>]*>)?\\s*\\(`),
    kind: () => 'method',
    name: (m) => m[1],
  },
  {
    ext: /\.(cs|cshtml|razor)$/i,
    re: new RegExp(`^\\s*(?:public|private|protected|internal)\\s+${MODS}[\\w<>\\[\\],.?]+\\s+([A-Za-z_]\\w*)\\s*(?:\\{|=>)`),
    kind: () => 'property',
    name: (m) => m[1],
  },
  // TypeScript / JavaScript.
  {
    ext: /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i,
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|enum|type|function\*?)\s+([A-Za-z_$][\w$]*)/,
    kind: (m) => (m[1].startsWith('function') ? 'function' : (m[1] as CodeSymbolKind)),
    name: (m) => m[2],
  },
  {
    ext: /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i,
    re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    kind: () => 'const',
    name: (m) => m[1],
  },
  // Python (and its stub files): classes, functions and methods, and a module's constants — an UPPER_CASE name
  // assigned at the start of a line (`MAX_RETRIES = 3`, `TIMEOUT: int = 30`), not a comparison.
  {
    ext: /\.pyi?$/i,
    re: /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/,
    kind: (m) => (m[1] === 'class' ? 'class' : 'function'),
    name: (m) => m[2],
  },
  {
    ext: /\.pyi?$/i,
    re: /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/,
    kind: () => 'const',
    name: (m) => m[1],
  },
];
/** Words that look like a member's name to the patterns but are statements. */
const NOT_NAMES = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'using',
  'lock',
  'return',
  'new',
  'nameof',
  'typeof',
  'await',
]);

/** A declaration on this line of this file, or null. Pure. */
export function declarationOf(path: string, text: string): { name: string; kind: CodeSymbolKind } | null {
  for (const r of RULES) {
    if (!r.ext.test(path)) continue;
    const m = r.re.exec(text);
    if (!m) continue;
    const name = r.name(m);
    if (NOT_NAMES.has(name)) continue;
    return { name, kind: r.kind(m) };
  }
  return null;
}

/** A name's words: at capitals (keeping runs like `HTTP` together), underscores and digits. */
export function nameParts(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
}

/**
 * What was typed is the starts of the name's words, in order (words may be skipped): `GPJ` and `gpj` for
 * GetPendingJobs, `AccKeys` and `acckeys` for AccountingKeys. Any case.
 */
export function startsOfParts(parts: string[], query: string): boolean {
  const ps = parts.map((p) => p.toLowerCase());
  const q = query.toLowerCase();
  const memo = new Map<string, boolean>();
  const from = (qi: number, pi: number): boolean => {
    if (qi === q.length) return true;
    const key = `${qi}:${pi}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let ok = false;
    for (let p = pi; p < ps.length && !ok; p++) {
      const part = ps[p];
      for (let k = Math.min(part.length, q.length - qi); k >= 1 && !ok; k--) {
        if (part.startsWith(q.slice(qi, qi + k))) ok = from(qi + k, p + 1);
      }
    }
    memo.set(key, ok);
    return ok;
  };
  return ps.length > 0 && ps.length <= 16 && from(0, 0);
}

/**
 * How well a name matches what was typed (lower is better), or null: exact, then a prefix, then a word of it
 * starting with it (`Keys` in `AccountingKeys`), then anywhere in it, then the starts of its words (`GPJ`,
 * `acckeys`). Pure.
 */
export function nameScore(name: string, query: string): number | null {
  return scoreOf(
    name.toLowerCase(),
    nameParts(name).map((p) => p.toLowerCase()),
    query.toLowerCase(),
  );
}

/** nameScore with the name already lower-cased and split (`lower`, `parts`) and the query lower-cased. */
function scoreOf(lower: string, parts: string[], q: string): number | null {
  if (!q) return null;
  if (lower === q) return 0;
  if (lower.startsWith(q)) return 1;
  if (parts.some((p) => p.startsWith(q))) return 2;
  if (lower.includes(q)) return 3;
  // The starts of its words: the first typed letter must start one of them.
  if (!parts.some((p) => p[0] === q[0])) return null;
  return startsOfParts(parts, q) ? 4 : null;
}

/** A declaration ready to match: its name lower-cased and split once, not on every keystroke. */
export interface PreparedSymbol {
  s: CodeSymbol;
  lower: string;
  parts: string[];
}

export function prepareSymbols(symbols: CodeSymbol[]): PreparedSymbol[] {
  return symbols.map((s) => ({ s, lower: s.name.toLowerCase(), parts: nameParts(s.name).map((p) => p.toLowerCase()) }));
}

const KIND_ORDER: Record<CodeSymbolKind, number> = {
  class: 0,
  interface: 0,
  record: 0,
  struct: 0,
  enum: 0,
  type: 0,
  function: 1,
  method: 1,
  property: 2,
  const: 2,
};

/** The declarations whose name matches, best first: how well, then types before members, then the shorter name. Pure. */
export function matchSymbols(symbols: CodeSymbol[] | PreparedSymbol[], query: string, limit = 50): CodeSymbol[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prepared = (symbols.length && 'lower' in symbols[0] ? symbols : prepareSymbols(symbols as CodeSymbol[])) as PreparedSymbol[];
  // Many declarations share a name (every Handle): scored once each.
  const byName = new Map<string, number | null>();
  const scored: Array<{ s: CodeSymbol; score: number }> = [];
  for (const p of prepared) {
    // By the name as written: its words depend on its case (GetStatus, Getstatus).
    let score = byName.get(p.s.name);
    if (score === undefined) byName.set(p.s.name, (score = scoreOf(p.lower, p.parts, q)));
    if (score !== null) scored.push({ s: p.s, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      KIND_ORDER[a.s.kind] - KIND_ORDER[b.s.kind] ||
      a.s.name.length - b.s.name.length ||
      a.s.path.localeCompare(b.s.path) ||
      a.s.line - b.s.line,
  );
  return scored.slice(0, limit).map((x) => x.s);
}
