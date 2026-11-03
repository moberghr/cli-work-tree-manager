import { describe, expect, it } from 'vitest';
import { fixingLines, fixMyselfBlocked, groupReviews, pendingDrafts, reviewSections } from '../../src/web/src/state/review-view.js';
import { demoReview } from '../../src/server/demo/demo-reviews.js';
import { summaryOf } from '../../src/core/review/review-build.js';

describe("the review's order (the tree and the diff alike)", () => {
  const r = demoReview(new Date('2026-11-02T10:00:00Z'));

  it('stories first, riskiest first, each with the test files that cover it under its code; then every other file by kind', () => {
    const sections = reviewSections(r);
    expect(sections.map((s) => [s.label, s.folded, s.entries.map((e) => `${e.role}:${e.path.split('/').pop()}`)])).toEqual([
      [
        'Refunds an order: handler and validator',
        false,
        ['code:RefundHandler.cs', 'code:RefundValidator.cs', 'test:RefundHandlerTests.cs'],
      ],
      ['Rounding half away from zero', false, ['code:Rounding.cs']],
      ['Schema', false, ['code:20261102_AddRefunds.cs']],
      ['API surface', false, ['code:RefundsController.cs']],
      ['Wiring', false, ['code:Program.cs']],
      ['Dependencies, build & CI', false, ['code:Shop.Orders.csproj']],
      ['Mechanical', true, ['code:OrderService.cs']],
      ['Generated', true, ['code:20261102_AddRefunds.Designer.cs', 'code:ShopDbModelSnapshot.cs', 'code:package-lock.json']],
    ]);
    // A story's test says what it tests; every file is in exactly one section.
    expect(sections[0].entries[2].why).toBe('tests RefundHandler.cs');
    expect(sections.flatMap((s) => s.entries.map((e) => e.path)).sort()).toEqual(r.files.map((f) => f.path).sort());
  });

  it('the drafts still to go out', () => {
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
