/**
 * PURE — the tests a pull request adds, changes, removes and skips, read
 * from its diff by each framework's patterns (#64): xUnit `[Fact]` /
 * `[Theory]` (+ `[InlineData]` rows), NUnit `[Test]` / `[TestCase]`, MSTest
 * `[TestMethod]` / `[DataRow]`, Jest / Vitest `it(` / `test(` (+ `.each`,
 * `.skip`, `xit`), pytest `def test_` (+ `parametrize`, `skip`). Nothing is
 * run: running a PR's tests is a session's job. Then which code each test
 * file covers (by name and imports), and the production changes no test
 * touches. Shared with the SPA and the demo; keep it import-free.
 */

export type TestChange = 'added' | 'changed' | 'removed' | 'skipped';
export type TestFramework = 'xunit' | 'nunit' | 'mstest' | 'jest' | 'pytest';
export type TestLevel = 'unit' | 'integration' | 'e2e';

export interface DiffLine {
  kind: 'add' | 'delete' | 'context' | 'no-newline';
  content: string;
}
export interface DiffFileLines {
  path: string;
  oldPath?: string;
  status: string;
  hunks: Array<{ lines: DiffLine[] }>;
}

export interface FoundTest {
  name: string;
  file: string;
  change: TestChange;
  framework: TestFramework;
  /** Parameterised: its data rows in the diff (InlineData, TestCase, DataRow), when counted. */
  cases?: number;
  level: TestLevel;
}

/** A method that is a test, by its attribute(s) on the lines above. */
const DOTNET_ATTR = /^\s*\[(Fact|Theory|Test|TestMethod|TestCase|InlineData|DataRow|SkippableFact|Ignore)\b(.*)$/;
const DOTNET_METHOD = /^\s*(?:public|private|internal|protected)?\s*(?:static\s+)?(?:async\s+)?(?:Task|ValueTask|void)\s+(\w+)\s*\(/;
const JS_TEST =
  /^\s*(x?it|x?test|it\.skip|test\.skip|it\.only|test\.only|it\.each|test\.each)\b\s*(?:\([^)]*\))?\s*(?:`[^`]*`\s*)?\(\s*(['"`])((?:\\.|(?!\2).)+)\2/;
const JS_TEST_EACH_TABLE = /^\s*(it|test)\.each\s*\(/;
const PY_TEST = /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/;
const PY_PARAM = /^\s*@pytest\.mark\.parametrize\b/;
const PY_SKIP = /^\s*@pytest\.mark\.(skip|skipif|xfail)\b/;

/** The level a test runs at, from its file's path and what its changed lines use. */
export function testLevel(path: string, text: string): TestLevel {
  if (/(^|\/)(e2e|playwright|cypress)(\/|\.|$)|\.e2e\./i.test(path)) return 'e2e';
  if (/integration/i.test(path) || /\b(WebApplicationFactory|Testcontainers|TestServer|IClassFixture<.*(Database|Db|Container))/.test(text))
    return 'integration';
  return 'unit';
}

interface Pending {
  framework: TestFramework;
  skipped: boolean;
  changedAttr: 'add' | 'delete' | null;
  cases: number;
}

/** The tests one file's diff touches. */
export function testsInFile(f: DiffFileLines): FoundTest[] {
  const out = new Map<string, FoundTest>();
  const text = f.hunks.flatMap((h) => h.lines.map((l) => l.content)).join('\n');
  const level = testLevel(f.path, text);
  /** Seen twice: removed and added again (its declaration line edited) is a change; a skip says the most. */
  const merge = (a: TestChange, b: TestChange): TestChange => {
    if (a === b) return a;
    if (a === 'skipped' || b === 'skipped') return 'skipped';
    if ((a === 'removed' && b === 'added') || (a === 'added' && b === 'removed')) return 'changed';
    return a === 'changed' ? b : a;
  };
  // A parameterised test's rows are counted when its table can be read (`tableRows`); otherwise no number is given.
  const put = (t: Omit<FoundTest, 'file' | 'level'>) => {
    const rest = t;
    const was = out.get(t.name);
    const cases = rest.cases ?? was?.cases;
    out.set(t.name, {
      ...(was ?? {}),
      ...rest,
      change: was ? merge(was.change, t.change) : t.change,
      file: f.path,
      level,
      ...(cases ? { cases } : {}),
    });
  };

  for (const hunk of f.hunks) {
    let pending: Pending | null = null;
    // The test the following changed lines are inside (a context declaration): they change it.
    let inside: { name: string; framework: TestFramework } | null = null;
    let pyPending: { rows: number | null; skip: boolean; changed: 'add' | 'delete' | null } = { rows: null, skip: false, changed: null };
    /** A `parametrize(` over several lines, read until its parentheses close (at most `MAX_TABLE_LINES`). */
    let pyTable: { text: string; lines: number } | null = null;
    for (const line of hunk.lines) {
      if (line.kind === 'no-newline') continue;
      const changed = line.kind === 'add' || line.kind === 'delete' ? line.kind : null;
      const c = line.content;

      const attr = DOTNET_ATTR.exec(c);
      if (attr) {
        const a = attr[1];
        const fw: TestFramework =
          a === 'Test' || a === 'TestCase' || a === 'Ignore' ? 'nunit' : a === 'TestMethod' || a === 'DataRow' ? 'mstest' : 'xunit';
        pending ??= { framework: fw, skipped: false, changedAttr: null, cases: 0 };
        if (a === 'InlineData' || a === 'TestCase' || a === 'DataRow') {
          if (line.kind !== 'delete') pending.cases++;
        } else pending.framework = fw;
        if (a === 'Ignore' || /\bSkip\s*=|\bIgnore\b/.test(attr[2])) pending.skipped = pending.skipped || line.kind === 'add';
        if (changed) pending.changedAttr ??= changed;
        continue;
      }
      const method = DOTNET_METHOD.exec(c);
      if (method && pending) {
        const change: TestChange = changed === 'add' ? 'added' : changed === 'delete' ? 'removed' : 'changed';
        const touched = changed !== null || pending.changedAttr !== null || pending.skipped;
        if (touched)
          put({
            name: method[1],
            change: pending.skipped && change !== 'removed' ? 'skipped' : change,
            framework: pending.framework,
            ...(pending.cases > 1 ? { cases: pending.cases } : {}),
          });
        inside = touched ? null : { name: method[1], framework: pending.framework };
        pending = null;
        continue;
      }

      const js = JS_TEST.exec(c);
      if (js) {
        const fn = js[1];
        // A skip counts only when the PR writes it: an `xit(` already there, shown as context, is no news.
        const skipped = fn.startsWith('x') || fn.endsWith('.skip');
        const change: TestChange = changed === 'add' ? (skipped ? 'skipped' : 'added') : changed === 'delete' ? 'removed' : 'changed';
        const rows = JS_TEST_EACH_TABLE.test(c) ? tableRows(c) : null;
        if (changed) put({ name: js[3], change, framework: 'jest', ...(rows && rows > 1 ? { cases: rows } : {}) });
        inside = changed ? null : { name: js[3], framework: 'jest' };
        continue;
      }

      if (pyTable) {
        if (line.kind !== 'delete') pyTable.text += `\n${c}`;
        if (changed) pyPending.changed ??= changed;
        if (parensClosed(pyTable.text) || ++pyTable.lines > MAX_TABLE_LINES) {
          pyPending.rows = tableRows(pyTable.text);
          pyTable = null;
        }
        continue;
      }
      if (PY_PARAM.test(c)) {
        if (changed) pyPending.changed ??= changed;
        if (parensClosed(c)) pyPending.rows = tableRows(c);
        else pyTable = { text: c, lines: 1 };
        continue;
      }
      if (PY_SKIP.test(c)) {
        pyPending.skip = pyPending.skip || line.kind === 'add';
        if (changed) pyPending.changed ??= changed;
        continue;
      }
      const py = PY_TEST.exec(c);
      if (py) {
        const touched = changed !== null || pyPending.changed !== null;
        const change: TestChange = changed === 'add' ? 'added' : changed === 'delete' ? 'removed' : 'changed';
        if (touched || pyPending.skip)
          put({
            name: py[1],
            change: pyPending.skip && change !== 'removed' ? 'skipped' : change,
            framework: 'pytest',
            ...(pyPending.rows && pyPending.rows > 1 ? { cases: pyPending.rows } : {}),
          });
        inside = touched ? null : { name: py[1], framework: 'pytest' };
        pyPending = { rows: null, skip: false, changed: null };
        continue;
      }

      // A changed line inside a test seen as context: that test changed.
      if (changed && inside && c.trim() !== '') {
        put({ name: inside.name, change: 'changed', framework: inside.framework });
        inside = null;
      }
    }
  }
  return [...out.values()];
}

const MAX_TABLE_LINES = 60;

/** Each bracket's depth change, outside string literals; `visit` sees every character at its depth. */
function walk(text: string, visit: (ch: string, depth: number) => boolean | void): void {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (visit(ch, depth) === true) return;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
}

/** The first `(` has its `)`: a decorator's call is read whole. */
function parensClosed(text: string): boolean {
  let open = 0;
  let seen = false;
  let closed = false;
  walk(text, (ch) => {
    if (ch === '(') {
      open++;
      seen = true;
    } else if (ch === ')' && --open === 0 && seen) return (closed = true);
  });
  return closed;
}

/**
 * The rows of a parameterised test's table written as a list (`it.each([[1], [2]])`, `parametrize("n", [1, 2])`):
 * the outer list's elements. Null when there's no list to count (a template table, `range(3)`, one left open).
 */
export function tableRows(text: string): number | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let listDepth = -1;
  let items = 0;
  let pending = false;
  let done = false;
  walk(text.slice(start), (ch, depth) => {
    if (listDepth < 0) {
      listDepth = depth;
      return;
    }
    if (depth === listDepth && ch === ']') return (done = true);
    if (depth === listDepth && ch === ',') {
      if (pending) items++;
      pending = false;
    } else if (!/\s/.test(ch)) pending = true;
  });
  if (!done) return null;
  return items + (pending ? 1 : 0);
}

/** The name a test file is about: `OrderServiceTests.cs` → `orderservice`, `order-service.test.ts` → `orderservice`. */
export function subjectOf(testPath: string): string {
  const file = testPath.split('/').pop() ?? testPath;
  const stem = file
    .replace(/\.(test|spec|e2e)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/^test_/i, '')
    .replace(/(_test|Tests?|IntegrationTests?|Spec)$/i, '');
  return normal(stem);
}

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const stemOf = (p: string) => normal((p.split('/').pop() ?? p).replace(/\.[^.]+$/, ''));

/** What a test file's changed lines import or use (`using A.B;`, `from '../x/order'`), as name stems. */
function importedStems(f: DiffFileLines): Set<string> {
  const out = new Set<string>();
  for (const l of f.hunks.flatMap((h) => h.lines)) {
    if (l.kind === 'delete') continue;
    const js = /from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/.exec(l.content);
    if (js) out.add(stemOf(js[1] ?? js[2]));
    const cs = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/.exec(l.content);
    if (cs) out.add(normal(cs[1].split('.').pop() ?? ''));
    const py = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(l.content);
    if (py) out.add(normal((py[1] ?? py[2]).split('.').pop() ?? ''));
    // A constructor or type used by name: `new OrderService(` / `OrderService.Create(`.
    for (const m of l.content.matchAll(/\bnew\s+([A-Z]\w+)\s*[(<]/g)) out.add(normal(m[1]));
  }
  out.delete('');
  return out;
}

export interface Coverage {
  /** A test file → the production files of the PR it covers. */
  covers: Record<string, string[]>;
  /** A production file → the test files of the PR that cover it. */
  coveredBy: Record<string, string[]>;
}

/** Which of the PR's production files each of its test files covers: by the test's name, then by what it imports or builds. */
export function matchTestsToCode(testFiles: DiffFileLines[], codePaths: string[]): Coverage {
  const covers: Record<string, string[]> = {};
  const coveredBy: Record<string, string[]> = {};
  for (const t of testFiles) {
    const subject = subjectOf(t.path);
    const used = importedStems(t);
    const hits = codePaths.filter((p) => {
      const stem = stemOf(p);
      return (subject && stem === subject) || used.has(stem);
    });
    covers[t.path] = hits;
    for (const p of hits) (coveredBy[p] ??= []).push(t.path);
  }
  return { covers, coveredBy };
}

export interface TestBreakdown {
  tests: FoundTest[];
  counts: Record<TestChange, number>;
  coverage: Coverage;
  /** Production changes (logic, schema, API) no test file of the PR touches. */
  gaps: string[];
  /** Tests removed or newly skipped: coverage that goes away quietly. */
  lost: FoundTest[];
  /** Only unit tests, while the PR changes the schema (a DB change only mocked). */
  unitOnlyForSchema: boolean;
}

/**
 * The PR's test breakdown: `files` its diff, `kinds` each file's kind
 * (change-kinds.ts) — the tests are the `tests` files, the code that wants
 * covering the logic, schema and API files.
 */
export function testBreakdown(files: DiffFileLines[], kinds: Record<string, string>): TestBreakdown {
  const testFiles = files.filter((f) => kinds[f.path] === 'tests');
  const code = files.filter((f) => ['logic', 'schema', 'api'].includes(kinds[f.path]) && f.status !== 'deleted').map((f) => f.path);
  const tests = testFiles.flatMap(testsInFile);
  const counts: Record<TestChange, number> = { added: 0, changed: 0, removed: 0, skipped: 0 };
  for (const t of tests) counts[t.change]++;
  const coverage = matchTestsToCode(testFiles, code);
  const schemaChanged = files.some((f) => kinds[f.path] === 'schema');
  const touched = tests.filter((t) => t.change !== 'removed');
  return {
    tests,
    counts,
    coverage,
    gaps: code.filter((p) => !coverage.coveredBy[p]?.length),
    lost: tests.filter((t) => t.change === 'removed' || t.change === 'skipped'),
    unitOnlyForSchema: schemaChanged && touched.length > 0 && touched.every((t) => t.level === 'unit'),
  };
}
