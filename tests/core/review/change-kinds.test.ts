import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  globToRegExp,
  groupByKind,
  importsOnly,
  rulesWith,
  whitespaceMatters,
  type ChangedFile,
  type ChangeKind,
} from '../../../src/core/review/change-kinds.js';

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'modified',
  added: 3,
  deleted: 1,
  changed: ['var total = items.Sum(i => i.Price);'],
  ...over,
});

describe('classifyFile: each kind, and why', () => {
  it.each<[string, Partial<ChangedFile>, ChangeKind, string]>([
    // Generated.
    ['src/Data/Migrations/20261101_AddRefunds.Designer.cs', {}, 'generated', 'EF Core migration designer'],
    ['src/Data/Migrations/AppDbContextModelSnapshot.cs', {}, 'generated', 'EF Core model snapshot'],
    ['package-lock.json', {}, 'generated', 'lockfile'],
    ['web/pnpm-lock.yaml', {}, 'generated', 'lockfile'],
    ['src/Api/Models.g.cs', {}, 'generated', 'generated source'],
    ['src/__snapshots__/view.test.ts.snap', {}, 'generated', 'snapshot'],
    ['public/app.min.js', {}, 'generated', 'minified'],
    ['src/anything.cs', { generated: true }, 'generated', 'marked generated in .gitattributes'],
    // Schema: the hand-written migration.
    ['src/Data/Migrations/20261101_AddRefunds.cs', {}, 'schema', 'migration'],
    ['db/migrations/004_refunds.sql', {}, 'schema', 'migration'],
    // Tests.
    ['tests/Orders.Tests/RefundTests.cs', {}, 'tests', 'test code'],
    ['src/orders/refund.test.ts', {}, 'tests', 'test code'],
    ['tests/test_refunds.py', {}, 'tests', 'test code'],
    // Dependencies, build, CI.
    ['src/Orders/Orders.csproj', {}, 'dependencies', 'package or project file'],
    ['package.json', {}, 'dependencies', 'package or project file'],
    ['.github/workflows/ci.yml', {}, 'dependencies', 'CI or container'],
    ['azure-pipelines.yml', {}, 'dependencies', 'CI or container'],
    // Wiring.
    ['src/Api/Program.cs', {}, 'wiring', 'startup'],
    ['src/Api/appsettings.Development.json', {}, 'wiring', 'configuration'],
    ['src/Orders/OrdersModule.cs', {}, 'wiring', 'startup'],
    ['src/Orders/Setup.cs', { changed: ['services.AddScoped<IRefunds, Refunds>();'] }, 'wiring', 'DI registration'],
    // API surface.
    ['src/Api/Controllers/RefundsController.cs', {}, 'api', 'controller or endpoint'],
    ['src/Api/Routes.cs', { changed: ['app.MapPost("/refunds", Handle);'] }, 'api', 'route or endpoint mapping'],
    // Logic.
    ['src/Orders/RefundPolicy.cs', {}, 'logic', 'no rule matched: hand-written code'],
  ])('%s → %s', (path, over, kind, why) => {
    expect(classifyFile(file(path, over))).toMatchObject({ path, kind, why });
  });

  it('a whitespace-only change where indentation is meaning (Python, YAML, Makefiles…) is never folded as mechanical', () => {
    for (const p of ['app/rates.py', '.github/workflows/ci.yml', 'deploy/values.yaml', 'Makefile', 'build/rules.mk', 'src/Calc.fs'])
      expect(whitespaceMatters(p), p).toBe(true);
    for (const p of ['src/Orders/Refund.cs', 'src/app.ts', 'docs/readme.md', 'makefile.txt']) expect(whitespaceMatters(p), p).toBe(false);
    expect(classifyFile(file('app/rates.py', { whitespaceOnly: true })).kind).toBe('logic');
    expect(classifyFile(file('.github/workflows/ci.yml', { whitespaceOnly: true })).kind).not.toBe('mechanical');
    expect(classifyFile(file('src/Orders/Refund.cs', { whitespaceOnly: true })).kind).toBe('mechanical');
  });

  it('mechanical: a pure rename, a whitespace-only change, only using / import lines — what git or the lines say', () => {
    expect(classifyFile(file('src/Orders/Refund.cs', { status: 'renamed', oldPath: 'src/Refund.cs', added: 0, deleted: 0 }))).toEqual({
      path: 'src/Orders/Refund.cs',
      kind: 'mechanical',
      why: 'pure rename from src/Refund.cs',
      by: 'git',
    });
    // A rename with edits is judged by what it is.
    expect(classifyFile(file('src/Orders/Refund.cs', { status: 'renamed', oldPath: 'src/Refund.cs' })).kind).toBe('logic');
    expect(classifyFile(file('src/Orders/Refund.cs', { whitespaceOnly: true }))).toMatchObject({
      kind: 'mechanical',
      why: 'whitespace only',
      by: 'git',
    });
    expect(
      classifyFile(
        file('src/Orders/Refund.cs', { changed: ['using System.Linq;', '', 'using Orders.Domain;', 'using static System.Math;'] }),
      ),
    ).toMatchObject({ kind: 'mechanical', why: 'only using / import lines changed' });
    expect(
      classifyFile(file('src/orders/refund.ts', { changed: ["import { sum } from './math.js';", "export { refund } from './refund.js';"] }))
        .kind,
    ).toBe('mechanical');
    // An added file with only imports is still a new file, not mechanical.
    expect(classifyFile(file('src/orders/index.ts', { status: 'added', changed: ["export { a } from './a.js';"] })).kind).toBe('logic');
    // A generated file renamed stays generated (the first rule wins).
    expect(classifyFile(file('package-lock.json', { status: 'renamed', added: 0, deleted: 0 })).kind).toBe('generated');
  });

  it('importsOnly needs at least one import and nothing else', () => {
    expect(importsOnly(['using System;'])).toBe(true);
    expect(importsOnly(['', '  '])).toBe(false);
    expect(importsOnly(['using System;', 'var x = 1;'])).toBe(false);
    expect(importsOnly(['from orders.refund import refund'])).toBe(true);
  });
});

describe('the rules are data', () => {
  it("a project's own rules come before the defaults; malformed ones are left out", () => {
    const rules = rulesWith([
      { kind: 'generated', name: 'our API client', paths: ['**/ApiClient/**'] },
      { kind: 'schema', name: 'Flyway', paths: ['**/db/V*__*.sql'] },
      { kind: 'nope', name: 'bad kind', paths: ['x'] },
      { kind: 'logic', name: 'no paths or content' },
      'nonsense',
    ]);
    expect(classifyFile(file('src/ApiClient/Orders.cs'), rules)).toMatchObject({ kind: 'generated', why: 'our API client' });
    expect(classifyFile(file('db/V3__refunds.sql'), rules)).toMatchObject({ kind: 'schema', why: 'Flyway' });
    expect(rules.filter((r) => r.name === 'bad kind' || r.name === 'no paths or content')).toEqual([]);
    expect(rulesWith(undefined).length).toBe(rulesWith([]).length);
  });

  it('a bad content pattern from config matches nothing rather than throwing', () => {
    const rules = rulesWith([{ kind: 'api', name: 'broken', content: ['(unclosed'] }]);
    expect(classifyFile(file('src/x.cs'), rules).kind).toBe('logic');
  });

  it('globs: ** spans folders, * one segment, {a,b} alternatives, a bare name matches anywhere', () => {
    expect(globToRegExp('**/Migrations/*.cs').test('src/Data/Migrations/X.cs')).toBe(true);
    expect(globToRegExp('**/Migrations/*.cs').test('Migrations/X.cs')).toBe(true);
    expect(globToRegExp('**/Migrations/*.cs').test('src/Migrations/sub/X.cs')).toBe(false);
    expect(globToRegExp('*.{yml,yaml}').test('a/b/c.yaml')).toBe(true);
    expect(globToRegExp('.github/workflows/**').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('.github/workflows/**').test('src/.github/workflows/ci.yml')).toBe(false);
    expect(globToRegExp('Program.cs').test('src/Api/Program.cs')).toBe(true);
  });
});

describe('groupByKind', () => {
  it("the review's order — what needs thought first, the folded kinds last — with empty groups left out", () => {
    const groups = groupByKind([
      { path: 'a', kind: 'generated' as const },
      { path: 'b', kind: 'logic' as const },
      { path: 'c', kind: 'schema' as const },
      { path: 'd', kind: 'logic' as const },
    ]);
    expect(groups.map((g) => [g.kind, g.files.map((f) => f.path)])).toEqual([
      ['schema', ['c']],
      ['logic', ['b', 'd']],
      ['generated', ['a']],
    ]);
  });
});
