import { describe, expect, it } from 'vitest';
import {
  allReviews,
  isReview,
  keepOnly,
  readReview,
  updateReview,
  upsertReview,
  writeReview,
} from '../../../src/core/review/review-store.js';
import { withDb } from '../../../src/core/platform/db.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';

// Each test file has its own HOME (tests/setup): this state.db is a throwaway.

describe('prepared reviews in state.db', () => {
  it('written, read back, changed in a transaction; a row of the wrong shape is dropped, not trusted', () => {
    const r = demoReview(new Date('2026-11-02T10:00:00Z'));
    writeReview(r);
    expect(readReview('api', 231)).toEqual(r);
    const next = updateReview('api', 231, (cur) => ({ ...cur, drafts: cur.drafts.slice(1) }));
    expect(next?.drafts).toHaveLength(1);
    expect(readReview('api', 231)?.drafts).toHaveLength(1);
    expect(updateReview('api', 999, (c) => c)).toBeNull();
    withDb((d) => d.prepare('INSERT OR REPLACE INTO pr_reviews (key, data) VALUES (?, ?)').run('api#5', '{"repo":"api","number":5}'));
    expect(readReview('api', 5)).toBeNull();
    expect(allReviews().map((x) => x.number)).toEqual([231]);
    expect(isReview({ ...r, status: 'bogus' })).toBe(false);
    expect(isReview({ ...r, dropped: 'x' })).toBe(false);
    expect(isReview({ ...r, inDoubt: { at: 'now' } })).toBe(false);
    expect(isReview({ ...r, inDoubt: { at: 'now', event: 'comment', drafts: [], summary: null, error: 'e' } })).toBe(true);
    // Fix it myself's batches: shape-checked, each comment too; a fork is `true` or absent.
    const fix = { at: 'now', sessionId: 's1', branch: 'feat/x', comments: [{ path: 'a.cs', line: 3, body: 'b', by: 'ai' }] };
    expect(isReview({ ...r, fork: true, fixingMyself: [fix] })).toBe(true);
    expect(isReview({ ...r, fork: 'yes' })).toBe(false);
    expect(isReview({ ...r, fixingMyself: fix })).toBe(false);
    expect(isReview({ ...r, fixingMyself: [{ ...fix, sessionId: 1 }] })).toBe(false);
    expect(isReview({ ...r, fixingMyself: [{ ...fix, comments: [{ path: 'a.cs', line: '3', body: 'b' }] }] })).toBe(false);
  });

  it('a submit claim, the last draft number and a Fix it myself claim: shape-checked, and they round-trip the real row (#64 F007)', () => {
    const r = demoReview(new Date('2026-11-02T10:00:00Z'));
    const claim = { at: '2026-11-02T10:00:00Z', pid: 4242, event: 'approve' as const, drafts: [{ id: 'd1', body: 'x' }], summary: null };
    const fixing = { at: '2026-11-02T10:00:00Z', drafts: ['d2'] };
    expect(isReview({ ...r, submitting: claim, lastDraft: 7, fixing })).toBe(true);
    expect(isReview({ ...r, submitting: { ...claim, pid: '4242' } })).toBe(false);
    expect(isReview({ ...r, submitting: { ...claim, at: 1 } })).toBe(false);
    expect(isReview({ ...r, submitting: { ...claim, drafts: 'd1' } })).toBe(false);
    expect(isReview({ ...r, submitting: null })).toBe(false);
    expect(isReview({ ...r, lastDraft: '7' })).toBe(false);
    expect(isReview({ ...r, fixing: { at: 'x', drafts: [1] } })).toBe(false);
    expect(isReview({ ...r, fixing: { drafts: [] } })).toBe(false);
    // Through state.db as the submit flow writes it: claimed in one transaction, read back whole.
    writeReview({ ...r, number: 77 });
    updateReview('api', 77, (cur) => ({ ...cur, submitting: claim, lastDraft: 7, fixing }));
    expect(readReview('api', 77)).toMatchObject({ submitting: claim, lastDraft: 7, fixing });
    // A row whose claim was damaged is dropped, never trusted as no claim at all.
    withDb((d) =>
      d
        .prepare('UPDATE pr_reviews SET data = ? WHERE key = ?')
        .run(JSON.stringify({ ...r, number: 77, submitting: { ...claim, pid: 'x' } }), 'api#77'),
    );
    expect(readReview('api', 77)).toBeNull();
    withDb((d) => d.prepare('DELETE FROM pr_reviews WHERE key = ?').run('api#77'));
  });

  it("drops the reviews of PRs no longer open — only for the repos asked (a repo that couldn't be listed keeps its own)", () => {
    writeReview({ ...demoReview(), number: 1 });
    writeReview({ ...demoReview(), number: 2 });
    writeReview({ ...demoReview(), repo: 'web', number: 3 });
    // api#5 (the malformed row above) is dropped by its key too.
    expect(keepOnly(['api'], new Set(['api#2', 'api#231']))).toEqual([
      { repo: 'api', number: 5 },
      { repo: 'api', number: 1 },
    ]);
    expect(
      allReviews()
        .map((x) => `${x.repo}#${x.number}`)
        .sort(),
    ).toEqual(['api#2', 'api#231', 'web#3']);
  });

  it('upsert reads and writes in one go: none stored gives null, a row of the wrong shape counts as none', () => {
    const seen: Array<number | null> = [];
    upsertReview('api', 40, (was) => {
      seen.push(was ? was.number : null);
      return { ...demoReview(), number: 40 };
    });
    upsertReview('api', 40, (was) => {
      seen.push(was ? was.number : null);
      return { ...was!, title: 'again' };
    });
    withDb((d) => d.prepare('INSERT OR REPLACE INTO pr_reviews (key, data) VALUES (?, ?)').run('api#41', '{"repo":"api"}'));
    upsertReview('api', 41, (was) => {
      seen.push(was ? was.number : null);
      return { ...demoReview(), number: 41 };
    });
    expect(seen).toEqual([null, 40, null]);
    expect(readReview('api', 40)!.title).toBe('again');
    expect(readReview('api', 41)!.number).toBe(41);
  });
});
