import { describe, expect, it, vi } from 'vitest';
import { settleLeftOverClaims, settlePrReview, shownReview, tidyLeftOverSubmits } from '../../../src/core/review/review-submit-flow.js';
import { LEFT_OVER_SUBMIT, shownDoubt } from '../../../src/core/review/review-submit.js';
import { createActivityLog } from '../../../src/core/platform/activity.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';
import type { PrReviewWire } from '../../../src/core/api-types.js';

/**
 * A submit claim a stopped work web left (#64 final F001): shown stale on read, settled by your word, and taken as in
 * doubt by the keeper's tidy — so the Reviews tab is never stuck on "Submitting…".
 */

const now = new Date('2026-11-02T10:00:00Z');
const claim = { at: '2026-11-02T09:59:00Z', pid: 99, event: 'comment' as const, drafts: [{ id: 'd1', body: 'sent?' }], summary: 'S' };

function store(alive: (pid: number) => boolean, rows = new Map<string, PrReviewWire>()) {
  rows.set('api#231', { ...demoReview(now), submitting: claim });
  return {
    rows,
    deps: {
      read: (repo: string, n: number) => rows.get(`${repo}#${n}`) ?? null,
      all: () => [...rows.values()],
      update: (repo: string, n: number, change: (r: PrReviewWire) => PrReviewWire) => {
        const was = rows.get(`${repo}#${n}`);
        if (!was) return null;
        const next = change(was);
        rows.set(`${repo}#${n}`, next);
        return next;
      },
      pid: 1,
      bootedAt: () => 0,
      alive,
      now: () => now,
    },
  };
}

describe('a submit claim left over', () => {
  it('shown stale (a read changes nothing), and the tab shows it as in doubt; a live one is shown as it is', () => {
    const gone = store(() => false);
    const shown = shownReview(gone.deps, gone.rows.get('api#231')!);
    expect(shown.submitting).toEqual({ ...claim, stale: true });
    expect(gone.rows.get('api#231')!.submitting).toEqual(claim);
    expect(shownDoubt(shown)).toMatchObject({ drafts: claim.drafts, summary: 'S', error: LEFT_OVER_SUBMIT, partial: true });
    const live = store(() => true);
    expect(shownReview(live.deps, live.rows.get('api#231')!).submitting?.stale).toBeUndefined();
    expect(shownDoubt(live.rows.get('api#231')!)).toBeUndefined();
  });

  it("settled by your word: it didn't go — the drafts are drafts again and the claim gone; nothing to settle is 409, none 404", () => {
    const gone = store(() => false);
    const out = settlePrReview(gone.deps, 'api', 231, false);
    expect(out.ok).toBe(true);
    const r = gone.rows.get('api#231')!;
    expect(r.submitting).toBeUndefined();
    expect(r.inDoubt).toBeUndefined();
    expect(r.drafts.find((d) => d.id === 'd1')!.state).toBe('draft');
    expect(settlePrReview(gone.deps, 'api', 231, false)).toMatchObject({ ok: false, status: 409 });
    expect(settlePrReview(gone.deps, 'api', 9, true)).toMatchObject({ ok: false, status: 404 });
  });

  it("the keeper's tidy takes each left-over claim as in doubt, says so in Activity at warn, and tells the dashboard", () => {
    const gone = store((pid) => pid !== 99);
    gone.rows.set('web#5', { ...demoReview(now), repo: 'web', number: 5, submitting: { ...claim, pid: 7 } }); // still running
    const activity = createActivityLog({ now: () => now.getTime() });
    const changed = vi.fn();
    tidyLeftOverSubmits(gone.deps, activity, changed);
    expect(gone.rows.get('api#231')!.submitting).toBeUndefined();
    expect(gone.rows.get('api#231')!.inDoubt).toMatchObject({ drafts: claim.drafts, error: LEFT_OVER_SUBMIT });
    expect(gone.rows.get('web#5')!.submitting).toBeDefined();
    expect(changed).toHaveBeenCalledWith({ repo: 'api', number: 231 });
    expect(changed).toHaveBeenCalledTimes(1);
    const notes = activity.snapshot().recent.flatMap((r) => r.notes);
    expect(notes).toEqual([
      expect.objectContaining({ level: 'warn', text: expect.stringContaining('api #231: work stopped while submitting') }),
    ]);
    // Nothing left over: nothing done, nothing said.
    expect(settleLeftOverClaims(gone.deps)).toEqual([]);
  });
});
