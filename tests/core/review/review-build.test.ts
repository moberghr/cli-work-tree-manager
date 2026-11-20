import { describe, expect, it } from 'vitest';
import { buildReview, kindsOf, reviewPrompt, splitIgnored } from '../../../src/core/review/review-build.js';
import { ignoredInReview } from '../../../src/core/review/change-kinds.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';

/**
 * A made-up PR shaped like a big real one (#64's dry run on a 48-file PR): a merchant step and a validator, an
 * entity, translations, a test-data builder in a shared tests project, Postgres tests on a base class, unit tests
 * that reach the validator through the handler, a migration, and a handler file big enough that the prompt can't
 * show every diff.
 */
const added = (path: string, lines: string[]) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');
const modified = (path: string, start: number, context: string[], plus: string[], minus: string[] = []) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${context.length + minus.length} +${start},${context.length + plus.length} @@`,
    ...context.map((l) => ` ${l}`),
    ...minus.map((l) => `-${l}`),
    ...plus.map((l) => `+${l}`),
  ].join('\n');

const filler = (n: number, word: string) =>
  Array.from({ length: n }, (_, i) => `        var ${word}${i} = Settle${word}(${i}, account, cancellationToken); // keep`);

const HANDLER = 'src/Shop.Admin/Handlers/Submissions/CreateMerchantFromSubmissionCommand.cs';
const VALIDATOR = 'src/Shop.Core/Types/Onboarding/SubmissionValidator.cs';
const ENTITY = 'src/Shop.Core/Data/Entities/Submission.cs';
const BIG = 'src/Shop.Admin/Handlers/Submissions/ZBulkImportCommand.cs';
const RESX = 'src/Shop.Resources/Translations.resx';
const RESX_IS = 'src/Shop.Resources/Translations.is-IS.resx';
const BUILDER = 'src/Shop.Tests.Shared/CreateSubmission.cs';
const PG_TEST = 'src/Shop.Tests/PostgreTests/Handlers/Submissions/SubmissionAuditPostgreTests.cs';
const UNIT_TEST = 'src/Shop.Tests/UnitTests/Handlers/Submissions/CreateMerchantFromSubmissionCommandTests.cs';
const MIGRATION = 'src/Shop.Migrator/Migrations/20261030142125_SubmissionAgreements.cs';

const diff = [
  added(HANDLER, [
    'using Shop.Core.Types.Onboarding;',
    'namespace Shop.Admin.Handlers.Submissions;',
    'public class CreateMerchantFromSubmissionCommandHandler',
    '{',
    '    public async Task Handle(CreateMerchantFromSubmissionCommand request)',
    '    {',
    '        SubmissionValidator.Validate(request.Submission);',
    '        await _bankAccounts.Create(request.Account); // inside the open transaction',
    '    }',
    '}',
  ]),
  modified(VALIDATOR, 8, ['public static class SubmissionValidator', '{'], ['    public static void Validate(ISubmissionFields f) { }']),
  modified(
    ENTITY,
    40,
    ['public class Submission', '{'],
    ['    /// <summary>Personal data: never log it.</summary>', '    public string? SignatorySsn { get; set; }'],
  ),
  added(BIG, ['namespace Shop.Admin.Handlers.Submissions;', 'public class ZBulkImportCommand', '{', ...filler(900, 'Row'), '}']),
  modified(
    RESX,
    4367,
    ['  </data>'],
    ['  <data name="SignatorySsnInvalid" xml:space="preserve">', '    <value>The signatory SSN is invalid</value>', '  </data>'],
  ),
  modified(
    RESX_IS,
    3715,
    ['  </data>'],
    ['  <data name="SignatorySsnInvalid" xml:space="preserve">', '    <value>Kennitala undirritara er ógild</value>', '  </data>'],
  ),
  added(BUILDER, [
    'namespace Shop.Tests.Shared;',
    'public static class CreateSubmission',
    '{',
    '    public static Submission New() => new Submission { SignatorySsn = "0101302989" };',
    '}',
  ]),
  added(PG_TEST, [
    'using Shop.Core.Data.Entities;',
    'namespace Shop.Tests.PostgreTests.Handlers.Submissions;',
    'public class SubmissionAuditPostgreTests : BasePostgreTest',
    '{',
    '    public SubmissionAuditPostgreTests(DatabaseFixture databaseFixture) : base(databaseFixture) { }',
    '    [Fact]',
    '    public async Task Update_WhenTheAgreementsAreReplaced_ThenAuditsBoth()',
    '    {',
    '        var s = CreateSubmission.New();',
    '    }',
    '}',
  ]),
  modified(
    UNIT_TEST,
    9,
    ['using Shop.Core.Types.Onboarding;', 'public class CreateMerchantFromSubmissionCommandTests', '{'],
    [
      '    [Fact]',
      '    public async Task Handle_WhenSignatorySsnIsInvalid_ThenThrows()',
      '    {',
      '        await Should.ThrowAsync<ValidationException>(() => Run());',
      '    }',
    ],
    ['    [Fact]', '    public async Task Handle_WhenSubmissionIsNew_ThenCreatesMerchant()', '    {', '        await Run();', '    }'],
  ),
  added(MIGRATION, [
    'public partial class SubmissionAgreements : Migration',
    '{',
    '    protected override void Up(MigrationBuilder b) { }',
    '}',
  ]),
].join('\n');

const files = parseGitDiff(`${diff}\n`);
const meta = {
  repo: 'shop',
  number: 3633,
  title: 'Partner submission agreements',
  url: 'u',
  author: 'a',
  branch: 'b',
  base: 'dev',
  headSha: 'h',
};
const extras = { whitespaceOnly: new Set<string>(), generated: new Set<string>() };

describe('a big PR read right', () => {
  it('kinds: translations are resources (mechanical), the test-data builder is test support, the code is logic', () => {
    const kinds = Object.fromEntries(kindsOf(files, extras).map((k) => [k.path, [k.kind, k.why]]));
    expect(kinds[RESX]).toEqual(['mechanical', 'resources or translations']);
    expect(kinds[RESX_IS]).toEqual(['mechanical', 'resources or translations']);
    expect(kinds[BUILDER]).toEqual(['tests', 'test support (shared test code, data builders, fixtures)']);
    expect(kinds[HANDLER][0]).toBe('logic');
    expect(kinds[MIGRATION][0]).toBe('schema');
  });

  it('the prompt lists every changed code file with its lines; a diff too big for the room is listed, not shown', () => {
    const p = reviewPrompt(meta, files, kindsOf(files, extras), { checkout: ['You are in a read-only checkout.'] })!;
    for (const path of [HANDLER, VALIDATOR, ENTITY, BIG, MIGRATION]) expect(p).toContain(`- ${path} (`);
    expect(p).toContain(`- ${BIG} (logic, +904 −0; diff not shown: no room in this prompt; changed lines 1-904)`);
    expect(p).not.toContain(`--- ${BIG}`);
    expect(p).toContain(`--- ${HANDLER}`);
    // Not code: never listed, never taking the room.
    for (const path of [RESX, RESX_IS, BUILDER, PG_TEST]) expect(p).not.toContain(`- ${path} (`);
  });

  it("the AI's notes: on a changed line of a file it read in the checkout, a draft; off its lines, set aside", () => {
    const answer = JSON.stringify({
      summary: 'Sales creates the merchant from a partner submission.',
      stories: [
        { title: 'Create Merchant step', why: 'w', risk: 'highest: money path', riskLevel: 4, flags: [], files: [HANDLER, BIG] },
        { title: 'Submission shape', why: 'w', risk: 'breaking contract', riskLevel: 4, flags: [], files: [VALIDATOR, ENTITY, MIGRATION] },
      ],
      notes: [
        { path: BIG, line: 500, body: 'One transaction for 900 rows?' },
        { path: BIG, line: 5000, body: 'off the diff' },
        { path: MIGRATION, line: 3, body: 'Index?' },
      ],
    });
    const r = buildReview(meta, files, extras, answer);
    expect(r.drafts.map((d) => [d.path, d.line])).toEqual([
      [BIG, 500],
      [MIGRATION, 3],
    ]);
    expect(r.dropped?.map((d) => [d.path, d.line])).toEqual([[BIG, 5000]]);
    // Its summary is the review's "In short"; an answer that names no story has none (stories by folder then).
    expect(r.summary).toBe('Sales creates the merchant from a partner submission.');
    expect(buildReview(meta, files, extras, JSON.stringify({ summary: 'S', stories: [] }))).not.toHaveProperty('summary');
    expect(buildReview(meta, files, extras, undefined)).not.toHaveProperty('summary');
    // Same risk: the AI's own order stands (it ranked Create Merchant first), not the one with more files.
    expect(r.stories.map((s) => s.title)).toEqual(['Create Merchant step', 'Submission shape']);
  });

  it("each code file's \"what changed here\" goes on its wire file; never a test's or a generated one's, nor without the AI step", () => {
    const answer = JSON.stringify({
      stories: [
        { title: 'Sales can create a merchant from a submission.', what: 'It does.', why: 'w', risk: 'r', riskLevel: 4, files: [HANDLER] },
      ],
      fileSummaries: {
        [HANDLER]: 'Creates the merchant and its contracts from the submission.',
        [MIGRATION]: 'Adds the agreements table.',
        [UNIT_TEST]: 'A test is not asked about.',
        [RESX]: 'Translations are not asked about.',
      },
    });
    const r = buildReview(meta, files, extras, answer);
    const summaries = Object.fromEntries(r.files.filter((f) => f.summary).map((f) => [f.path, f.summary]));
    expect(summaries).toEqual({
      [HANDLER]: 'Creates the merchant and its contracts from the submission.',
      [MIGRATION]: 'Adds the agreements table.',
    });
    expect(r.stories[0].what).toBe('It does.');
    // An answer with no story (stories by folder) or no AI step: no file says what changed in it.
    const noStory = JSON.stringify({ stories: [], fileSummaries: { [HANDLER]: 'x' } });
    expect(buildReview(meta, files, extras, noStory).files.some((f) => f.summary)).toBe(false);
    expect(buildReview(meta, files, extras, undefined).files.some((f) => f.summary)).toBe(false);
  });

  it('tests: the Postgres ones are integration, so no "unit tests only" warning; removed tests cover nothing; the validator is reached through the handler tests', () => {
    const r = buildReview(
      meta,
      files,
      extras,
      JSON.stringify({
        stories: [{ title: 'Create Merchant step', why: 'w', risk: 'r', riskLevel: 4, files: [HANDLER, VALIDATOR, ENTITY] }],
      }),
    );
    const levels = Object.fromEntries(r.tests.list.map((t) => [t.name, [t.level, t.change]]));
    expect(levels).toEqual({
      Update_WhenTheAgreementsAreReplaced_ThenAuditsBoth: ['integration', 'added'],
      Handle_WhenSignatorySsnIsInvalid_ThenThrows: ['unit', 'added'],
      Handle_WhenSubmissionIsNew_ThenCreatesMerchant: ['unit', 'removed'],
    });
    expect(r.tests.unitOnlyForSchema).toBe(false);
    expect(r.stories[0].tests).toEqual([
      'Update_WhenTheAgreementsAreReplaced_ThenAuditsBoth',
      'Handle_WhenSignatorySsnIsInvalid_ThenThrows',
    ]);
    // The validator: its namespace is imported by the handler's tests. The entity: named by the Postgres test's import.
    expect(r.tests.gaps).not.toContain(VALIDATOR);
    expect(r.tests.gaps).not.toContain(ENTITY);
    // Neither translations nor the builder are untested code; the builder covers nothing (it tests nothing).
    expect(r.tests.gaps).not.toContain(RESX);
    expect(r.tests.gaps).not.toContain(BUILDER);
    expect(r.tests.covers[BUILDER]).toBeUndefined();
  });
});

describe('designer files are left out of the review altogether (reported)', () => {
  const diff = (path: string, lines: number) =>
    `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+l${i}`).join('\n')}\n`;
  const files = parseGitDiff(
    diff('src/Migrator/Migrations/20261106_AddTerms.Designer.cs', 5) +
      diff('src/Web/Forms/Main.Designer.cs', 2) +
      diff('src/Payments/TermsLink.cs', 3),
  );

  it('ignoredInReview: any *.Designer.cs, nothing else', () => {
    expect(ignoredInReview('src/Migrator/Migrations/20261106_AddTerms.Designer.cs')).toBe('designer file');
    expect(ignoredInReview('Resources/Strings.Designer.cs')).toBe('designer file');
    expect(ignoredInReview('src/Payments/TermsLink.cs')).toBeNull();
    expect(ignoredInReview('src/Designer.cs.md')).toBeNull();
  });

  it('splitIgnored keeps the rest; buildReview names the left-out ones apart and counts them in the size only', () => {
    const split = splitIgnored(files);
    expect(split.files.map((f) => f.path)).toEqual(['src/Payments/TermsLink.cs']);
    expect(split.ignored.map((f) => [f.path, f.added])).toEqual([
      ['src/Migrator/Migrations/20261106_AddTerms.Designer.cs', 5],
      ['src/Web/Forms/Main.Designer.cs', 2],
    ]);
    const meta = { repo: 'api', number: 1, title: 't', url: 'u', author: 'a', branch: 'b', base: 'main', headSha: 'h' };
    const r = buildReview(meta, split.files, { whitespaceOnly: new Set(), generated: new Set() }, undefined, { ignored: split.ignored });
    expect(r.files.map((f) => f.path)).toEqual(['src/Payments/TermsLink.cs']);
    expect(r.ignored).toHaveLength(2);
    expect(r.size).toEqual({ files: 3, added: 10, deleted: 0 });
    // Nothing of them reaches the AI step's prompt.
    const prompt = reviewPrompt(meta, split.files, kindsOf(split.files, { whitespaceOnly: new Set(), generated: new Set() }));
    expect(prompt ?? '').not.toContain('Designer.cs');
  });
});
