import { describe, expect, it } from 'vitest';
import {
  notPreparedLine,
  changeType,
  commentContext,
  commentsByFile,
  diffstatBlocks,
  fileOnScreen,
  commentWalk,
  fixingLines,
  fixMyselfBlocked,
  gist,
  groupReviews,
  inShort,
  folderParts,
  nameParts,
  notWorthReading,
  pageOf,
  plainProse,
  proseParts,
  pendingDrafts,
  reviewPages,
  reviewProgress,
  shortLabel,
  shortWhere,
  splitPath,
  storyCards,
  testsLine,
  viewedCount,
  filesTree,
  filesViewed,
  foldedInFiles,
  mdGist,
} from '../../src/web/src/state/review-view.js';
import { demoReview, demoReviewFiles } from '../../src/server/demo/demo-reviews.js';
import { summaryOf } from '../../src/core/review/review-build.js';
import { parseGitDiff } from '../../src/core/diff/diff-parse.js';
import type { PrReviewWire } from '../../src/core/api-types.js';

const name = (p: string) => p.split('/').pop();

describe("the story pager's pages", () => {
  const r = demoReview(new Date('2026-11-02T10:00:00Z'));

  it('the stories first (riskiest first, only their code), then each kind of change no story took; generated and mechanical folded', () => {
    const pages = reviewPages(r);
    expect(pages.map((p) => [p.label, p.folded, p.code.map((e) => name(e.path))])).toEqual([
      [
        'Support staff can now refund part of a paid order, and the refunded amount is recorded on the order.',
        false,
        ['RefundHandler.cs', 'RefundValidator.cs'],
      ],
      ['Prices that end in half a cent now round away from zero instead of to the nearest even cent.', false, ['Rounding.cs']],
      ['Schema', false, ['20261102_AddRefunds.cs']],
      ['API surface', false, ['RefundsController.cs']],
      ['Wiring', false, ['Program.cs']],
      ['Dependencies, build & CI', false, ['Shop.Orders.csproj']],
      ['Mechanical', true, ['OrderService.cs']],
      ['Generated', true, ['ShopDbModelSnapshot.cs', 'package-lock.json']], // the designer file is left out of the review
    ]);
    // Every file is read somewhere: as code of one page, or as a story's test.
    const read = new Set(pages.flatMap((p) => [...p.code, ...p.tests].map((e) => e.path)));
    expect([...read].sort()).toEqual(r.files.map((f) => f.path).sort());
  });

  it("a story's tests fold into one line: how many cover it, added, changed; none said so", () => {
    const [refunds, rounding] = reviewPages(r);
    expect(refunds.tests.map((e) => [name(e.path), e.why])).toEqual([['RefundHandlerTests.cs', 'tests RefundHandler.cs']]);
    expect(testsLine(refunds)).toBe('2 tests in 1 file cover this · 2 added');
    expect(testsLine(rounding)).toBe('No test of this PR covers it');
  });

  it('a test file covering two stories is under both (its cases counted once each); a test covering none is the Tests page', () => {
    const two: PrReviewWire = {
      ...r,
      tests: {
        ...r.tests,
        covers: {
          ...r.tests.covers,
          'tests/Shop.Orders.Tests/RefundHandlerTests.cs': [r.stories[0].files[0], 'src/Shop.Orders/Pricing/Rounding.cs'],
        },
      },
    };
    const pages = reviewPages(two);
    expect(pages[0].tests).toHaveLength(1);
    expect(pages[1].tests).toHaveLength(1);
    expect(pages.some((p) => p.kind === 'tests')).toBe(false);
    const none = reviewPages({ ...r, tests: { ...r.tests, covers: {} } });
    expect(none.find((p) => p.kind === 'tests')!.code.map((e) => name(e.path))).toEqual(['RefundHandlerTests.cs']);
  });

  it('where a file is read: its page (code first, else a story test), -1 for none', () => {
    const pages = reviewPages(r);
    expect(pageOf(pages, 'src/Shop.Orders/Pricing/Rounding.cs')).toBe(1);
    expect(pageOf(pages, 'tests/Shop.Orders.Tests/RefundHandlerTests.cs')).toBe(0);
    expect(pageOf(pages, 'nope.cs')).toBe(-1);
  });

  it('progress: files ticked viewed of a page, and of the whole review leaving the folded kinds out', () => {
    const pages = reviewPages(r);
    const viewed = new Set(['src/Shop.Orders/Refunds/RefundHandler.cs', 'web/package-lock.json']);
    expect(viewedCount(pages[0].code, viewed)).toEqual({ viewed: 1, total: 2 });
    expect(reviewProgress(pages, viewed)).toEqual({ viewed: 1, total: 7 });
  });
});

describe('the overview', () => {
  const r = demoReview(new Date('2026-11-02T10:00:00Z'));

  it('story cards: number, title, what it does (its first sentence shown), risk, flags, files, comments, and how its tests stand', () => {
    const cards = storyCards(r, reviewPages(r));
    expect(cards.map(({ what: _w, ...c }) => c)).toEqual([
      {
        page: 0,
        number: 1,
        title: 'Support staff can now refund part of a paid order, and the refunded amount is recorded on the order.',
        lead: 'A refund request for an order is sent to the payment provider for the requested amount, and the amount is then added to the order’s new Refunded total.',
        riskLevel: 5,
        flags: ['data-loss', 'concurrency'],
        codeFiles: 2,
        comments: 2,
        // Its validator is on the Untested list: the card says so beside the tests that cover the handler.
        tests: { state: 'covered', text: '2 tests', untested: '1 file untested' },
      },
      {
        page: 1,
        number: 2,
        title: 'Prices that end in half a cent now round away from zero instead of to the nearest even cent.',
        lead: 'Rounding.Cents now passes MidpointRounding.AwayFromZero, so 2.345 becomes 2.35 where it used to become 2.34.',
        riskLevel: 3,
        flags: ['public-contract', 'no-tests'],
        codeFiles: 1,
        comments: 0,
        tests: { state: 'gap', text: 'no tests', untested: null },
      },
    ]);
    expect(cards[0].what).toBe(r.stories[0].what);
    expect(r.tests.gaps).toContain('src/Shop.Orders/Refunds/RefundValidator.cs');
    // A story from before (no "what"): no lead; every file tested: nothing untested said.
    const old = { ...r, stories: r.stories.map(({ what: _w, ...s }) => s), tests: { ...r.tests, gaps: [] } };
    const first = storyCards(old, reviewPages(old))[0];
    expect(first).not.toHaveProperty('lead');
    expect(first.tests).toEqual({ state: 'covered', text: '2 tests', untested: null });
  });

  it('a story with a schema change and only unit tests says "unit tests only"', () => {
    const schema = 'src/Shop.Data/Migrations/20261102_AddRefunds.cs';
    const withSchema: PrReviewWire = { ...r, stories: [{ ...r.stories[0], files: [...r.stories[0].files, schema] }, r.stories[1]] };
    expect(storyCards(withSchema, reviewPages(withSchema))[0].tests).toEqual({
      state: 'unit-only',
      text: '2 unit tests only',
      untested: '2 files untested',
    });
  });

  it('in short: the AI step’s summary, else the story titles as bullets', () => {
    expect(inShort(r)).toEqual({ summary: expect.stringContaining('Adds partial refunds') });
    expect(inShort({ ...r, summary: undefined })).toEqual({
      bullets: [
        'Support staff can now refund part of a paid order, and the refunded amount is recorded on the order.',
        'Prices that end in half a cent now round away from zero instead of to the nearest even cent.',
      ],
    });
  });

  it('not worth reading: generated, translations and mechanical counted apart, with the files', () => {
    // The migration's designer is left out of the review altogether (named, never diffed): 2 generated, not 3.
    expect(notWorthReading(r)!.line).toBe('2 generated · 1 mechanical · 1 designer file left out');
    expect(notWorthReading(r)!.ignored.map((f) => name(f.path))).toEqual(['20261102_AddRefunds.Designer.cs']);
    const resx = {
      ...r.files[0],
      path: 'src/Res/Translations.resx',
      kind: 'mechanical' as const,
      why: 'resources or translations',
    };
    const out = notWorthReading({ ...r, files: [...r.files, resx, { ...resx, path: 'src/Res/Translations.is.resx' }] })!;
    expect(out.line).toBe('2 generated · 2 translations · 1 mechanical · 1 designer file left out');
    expect(out.files.map((f) => name(f.path))).toEqual([
      'ShopDbModelSnapshot.cs',
      'package-lock.json',
      'Translations.resx',
      'Translations.is.resx',
      'OrderService.cs',
    ]);
    expect(
      notWorthReading({ ...r, ignored: undefined, files: r.files.filter((f) => f.kind !== 'generated' && f.kind !== 'mechanical') }),
    ).toBeNull();
  });

  it("a comment's gist is its first sentence, cut at a word; where it is, short", () => {
    expect(gist('Two refunds at once both read the old `Refunded`. Guard it.')).toBe('Two refunds at once both read the old `Refunded`.');
    expect(gist('no full stop at all')).toBe('no full stop at all');
    expect(gist('word '.repeat(60), 40)).toMatch(/^(word ){6}word…$/);
    expect(shortWhere({ path: 'src/a/B.cs', line: 7 })).toBe('B.cs:7');
    expect(splitPath('src/a/B.cs')).toEqual({ name: 'B.cs', folder: 'src/a' });
    expect(splitPath('B.cs')).toEqual({ name: 'B.cs', folder: '' });
  });
});

describe('the comments walk', () => {
  const r = demoReview(new Date('2026-11-02T10:00:00Z'));

  it("in the review's order: the page the file is read on, then its place there, then the line; posted ones left out", () => {
    const pages = reviewPages(r);
    const mixed: PrReviewWire = {
      ...r,
      drafts: [
        { id: 'u1', path: 'src/Shop.Api/Controllers/RefundsController.cs', line: 5, body: 'api', state: 'draft', by: 'you' },
        { id: 'u2', path: 'src/Shop.Orders/Refunds/RefundValidator.cs', line: 2, body: 'validator', state: 'draft', by: 'you' },
        ...r.drafts.slice().reverse(),
        { id: 'p1', path: 'src/Shop.Orders/Refunds/RefundHandler.cs', line: 1, body: 'gone out', state: 'posted' },
      ],
    };
    expect(commentWalk(mixed, pages).map((d) => d.id)).toEqual(['d1', 'd2', 'u2', 'u1']);
  });

  it('the code around a comment: the hunk lines within the radius, both sides, numbered as in the file', () => {
    const [file] = parseGitDiff(
      [
        'diff --git a/x.cs b/x.cs',
        'index 1..2 100644',
        '--- a/x.cs',
        '+++ b/x.cs',
        '@@ -10,8 +10,8 @@ class X',
        ' a',
        ' b',
        ' c',
        '-old d',
        '+new d',
        ' e',
        ' f',
        ' g',
        ' h',
      ].join('\n'),
    );
    const ctx = commentContext(file, 13, 2)!;
    expect(ctx.hunks).toHaveLength(1);
    expect(ctx.hunks[0].lines.map((l) => `${l.kind}:${l.content}`)).toEqual([
      'context:c',
      'delete:old d',
      'add:new d',
      'context:e',
      'context:f',
    ]);
    expect(ctx.hunks[0]).toMatchObject({ oldStart: 12, newStart: 12, oldLines: 4, newLines: 4, context: 'class X' });
    expect([ctx.added, ctx.deleted]).toEqual([1, 1]);
    expect(commentContext(file, 99)).toBeNull();
  });

  it("a new file's comment gets its lines around it", () => {
    const handler = demoReviewFiles().find((f) => f.path.endsWith('RefundHandler.cs'))!;
    const ctx = commentContext(handler, 6, 7)!;
    expect(ctx.hunks[0].lines[0].newNum).toBe(1);
    expect(ctx.hunks[0].lines.at(-1)!.newNum).toBe(11);
    expect(ctx.status).toBe('added');
  });
});

describe('the drafts still to go out', () => {
  const r = demoReview(new Date('2026-11-02T10:00:00Z'));
  it('only the drafts', () => {
    expect(
      pendingDrafts({ ...r, drafts: r.drafts.map((d, i) => (i === 0 ? { ...d, state: 'posted' as const } : d)) }).map((d) => d.id),
    ).toEqual(['d2']);
  });
});

describe('the list of reviews', () => {
  const at = (iso: string, repo: string, number: number, host?: string) => ({
    ...summaryOf(demoReview(new Date(iso))),
    repo,
    number,
    ...(host ? { host } : {}),
  });
  const list = [
    at('2026-11-01T10:00:00Z', 'api', 1),
    at('2026-11-02T10:00:00Z', 'payments', 7, 'azure'),
    at('2026-11-02T09:00:00Z', 'api', 2),
  ];

  it('by repo: the repo with the newest push first, the newest first within it, with its host', () => {
    expect(groupReviews(list, 'repo').map((g) => [g.repo, g.host ?? null, g.reviews.map((r) => r.number)])).toEqual([
      ['payments', 'azure', [7]],
      ['api', null, [2, 1]],
    ]);
  });

  it('none: one list, newest first', () => {
    expect(groupReviews(list, 'none')).toEqual([{ repo: null, reviews: [list[1], list[2], list[0]] }]);
  });
});

describe('Fix it myself, as the tab shows it', () => {
  const r = demoReview(new Date('2026-11-02T10:00:00Z'));
  it('offered unless a fork, a submit in doubt or under way, or no draft left; why it is not, in words', () => {
    expect(fixMyselfBlocked(r)).toBeNull();
    expect(fixMyselfBlocked({ ...r, fork: true })).toContain('fork');
    expect(fixMyselfBlocked({ ...r, inDoubt: { at: 'x', event: 'comment', drafts: [], summary: null, error: 'e' } })).toContain(
      'may have gone out',
    );
    expect(fixMyselfBlocked({ ...r, submitting: { at: 'x', pid: 1, event: 'comment', drafts: [], summary: null } })).toContain(
      'being submitted',
    );
    expect(fixMyselfBlocked({ ...r, drafts: r.drafts.map((d) => ({ ...d, state: 'posted' as const })) })).toBe('No draft comments to fix');
  });
  it('each batch taken off: how many, in the session (by name, else its branch)', () => {
    const batch = (sessionId: string, n: number) => ({
      at: 'x',
      sessionId,
      branch: 'feat/refunds',
      comments: Array.from({ length: n }, () => ({ path: 'a', line: 1, body: 'b' })),
    });
    expect(fixingLines({ ...r, fixingMyself: [batch('s1', 3), batch('s2', 1)] }, (id) => (id === 's1' ? 'Refunds' : null))).toEqual([
      { sessionId: 's1', text: '3 comments being fixed in Refunds' },
      { sessionId: 's2', text: '1 comment being fixed in feat/refunds' },
    ]);
  });
});

describe('a long file name in the tree', () => {
  it('wraps between words, never mid-word; the parts make the name', () => {
    expect(nameParts('CreateMerchantFromPartnerSubmissionCommand.cs')).toEqual([
      'Create',
      'Merchant',
      'From',
      'Partner',
      'Submission',
      'Command.cs',
    ]);
    expect(nameParts('use-deferred_diff.ts')).toEqual(['use-', 'deferred_', 'diff.ts']);
    expect(nameParts('review-view.test.ts')).toEqual(['review-', 'view.', 'test.ts']);
    expect(nameParts('.gitignore')).toEqual(['.gitignore']);
    expect(nameParts('README')).toEqual(['README']);
  });

  it('a folder wraps only after a slash, never inside a name; the parts put back are the folder', () => {
    const folder = 'src/Payfac.Services.Admin/Handlers/Onboarding';
    expect(folderParts(folder)).toEqual(['src/', 'Payfac.Services.Admin/', 'Handlers/', 'Onboarding']);
    expect(folderParts(folder).join('')).toBe(folder);
    expect(folderParts('')).toEqual([]);
    expect(folderParts('one')).toEqual(['one']);
  });

  it('the AI step’s prose: what is between backticks is code, the rest plain text; a lone backtick stays', () => {
    expect(proseParts('Calls `CreateBankAccount` and `StageMerchant`.')).toEqual([
      { text: 'Calls ' },
      { text: 'CreateBankAccount', code: true },
      { text: ' and ' },
      { text: 'StageMerchant', code: true },
      { text: '.' },
    ]);
    expect(proseParts('No code here.')).toEqual([{ text: 'No code here.' }]);
    expect(proseParts('A lone ` backtick')).toEqual([{ text: 'A lone ` backtick' }]);
    expect(plainProse('Calls `CreateBankAccount` once.')).toBe('Calls CreateBankAccount once.');
  });

  it("a story's sentence on a button: its first sentence, cut at a word", () => {
    expect(shortLabel('Schema')).toBe('Schema');
    const label = shortLabel(
      'Support staff can now refund part of a paid order, and the refunded amount is recorded on the order and more.',
      60,
    );
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).toBe('Support staff can now refund part of a paid order, and the…');
  });
});

describe('a file row: what kind of change, how big, its comments', () => {
  it('the change as a letter: A added, M modified, D deleted, R renamed (from where), B binary', () => {
    expect(changeType({ status: 'added' })).toEqual({ type: 'added', letter: 'A', label: 'Added' });
    expect(changeType({ status: 'modified' })).toEqual({ type: 'modified', letter: 'M', label: 'Modified' });
    expect(changeType({ status: 'deleted' })).toEqual({ type: 'deleted', letter: 'D', label: 'Deleted' });
    expect(changeType({ status: 'renamed', oldPath: 'a/Old.cs' })).toEqual({
      type: 'renamed',
      letter: 'R',
      label: 'Renamed from a/Old.cs',
    });
    expect(changeType({ status: 'binary' }).letter).toBe('B');
    // Anything else reads as modified; a modified file with an old path was renamed.
    expect(changeType({ status: 'copied' }).type).toBe('modified');
    expect(changeType({ status: 'modified', oldPath: 'x.cs' }).type).toBe('renamed');
  });

  it("GitHub's five-block diffstat: the shares in green and red, each side with a line keeps a block", () => {
    expect(diffstatBlocks(222, 0)).toEqual(['add', 'add', 'add', 'add', 'add']);
    expect(diffstatBlocks(0, 40)).toEqual(['del', 'del', 'del', 'del', 'del']);
    expect(diffstatBlocks(60, 40)).toEqual(['add', 'add', 'add', 'del', 'del']);
    expect(diffstatBlocks(500, 1)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(diffstatBlocks(1, 500)).toEqual(['add', 'del', 'del', 'del', 'del']);
    expect(diffstatBlocks(2, 1)).toEqual(['add', 'add', 'del', 'none', 'none']);
    expect(diffstatBlocks(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none']);
  });

  it('the draft comments still to go out, per file (posted ones left out)', () => {
    const r = demoReview(new Date('2026-11-02T10:00:00Z'));
    const handler = 'src/Shop.Orders/Refunds/RefundHandler.cs';
    expect([...commentsByFile(r)]).toEqual([[handler, 2]]);
    const posted = { ...r, drafts: r.drafts.map((d, i) => (i === 0 ? { ...d, state: 'posted' as const } : d)) };
    expect(commentsByFile(posted).get(handler)).toBe(1);
  });

  it('the file on screen: the last whose top reached the line, else the first', () => {
    const tops = [
      { path: 'a', top: 0 },
      { path: 'b', top: 400 },
      { path: 'c', top: 900 },
    ];
    expect(fileOnScreen(tops, 50)).toBe('a');
    expect(fileOnScreen(tops, 450)).toBe('b');
    expect(fileOnScreen(tops, 5000)).toBe('c');
    expect(fileOnScreen([{ path: 'a', top: 100 }], 0)).toBe('a');
    expect(fileOnScreen([], 0)).toBeNull();
  });
});

describe("the Files view's tree (GitHub's Files changed)", () => {
  it('folders first, then files, by name; a folder holding one folder joined with it; the diffs in the tree order', () => {
    const f = (path: string, kind = 'logic') => ({ ...demoReview().files[0], path, kind }) as PrReviewWire['files'][number];
    const { nodes, order } = filesTree([f('src/b/Z.cs'), f('README.md'), f('src/a/x/Y.cs'), f('src/b/a.cs'), f('src/c.cs')]);
    const show = (ns: typeof nodes): unknown[] => ns.map((n) => (n.kind === 'folder' ? { [n.name]: show(n.children) } : n.name));
    expect(show(nodes)).toEqual([{ src: [{ 'a/x': ['Y.cs'] }, { b: ['a.cs', 'Z.cs'] }, 'c.cs'] }, 'README.md']);
    expect(order).toEqual(['src/a/x/Y.cs', 'src/b/a.cs', 'src/b/Z.cs', 'src/c.cs', 'README.md']);
    expect(foldedInFiles({ kind: 'generated' })).toBe(true);
    expect(foldedInFiles({ kind: 'mechanical' })).toBe(false);
  });

  it('viewed counts every file of the PR', () => {
    const r = demoReview();
    expect(filesViewed(r, new Set([r.files[0].path, 'not/in/it.cs']))).toEqual({ viewed: 1, total: r.files.length });
  });
});

describe("someone's Markdown on one line (the PR's discussion)", () => {
  it('drops HTML comments, headings, emphasis, tables and link targets; keeps what it says', () => {
    expect(mdGist('<!-- ccr-overview-v2 -->\n\n### 🟡 Changes recommended\n\nAgreement-only edits can bypass checks. More.')).toBe(
      '🟡 Changes recommended Agreement-only edits can bypass checks.',
    );
    expect(mdGist('**Available commands:**\n| Command | Description |\n|---|---|\n| `/deploy` | Deploy |')).toBe('Available commands:');
    expect(mdGist('See [the docs](https://x/y) for `Foo`.')).toBe('See the docs for `Foo`.');
  });
});

describe('where a review would be, while none is prepared', () => {
  it('says why and what to do; nothing once it is ready', () => {
    expect(notPreparedLine({ status: 'ready', why: null })).toBeNull();
    expect(notPreparedLine({ status: 'waiting', held: 'size', why: 'x' })).toMatch(/size limit .* Prepare it now reads it anyway/);
    expect(notPreparedLine({ status: 'waiting', held: 'cap', why: 'x' })).toMatch(/day’s automatic reviews are done/);
    expect(notPreparedLine({ status: 'failed', why: 'git fetch failed' })).toBe(
      'Preparing it failed (git fetch failed). Prepare it now tries again; you can still approve or comment below.',
    );
    expect(notPreparedLine({ status: 'queued', why: null })).toMatch(/In line/);
    expect(notPreparedLine({ status: 'running', why: null })).toMatch(/Being prepared/);
  });
});
