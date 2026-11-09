import { describe, expect, it } from 'vitest';
import {
  addDraft,
  afterFailedSubmit,
  afterSubmit,
  carryForward,
  claimStale,
  claimToDoubt,
  clearDropped,
  isStaleRunning,
  lastDraftNumber,
  nothingToSubmit,
  onDiffLine,
  withClaim,
  preparedOn,
  removeDraft,
  settleInDoubt,
  submitComments,
  submitRefusal,
  summaryToSend,
} from '../../../src/core/review/review-submit.js';
import { buildReview, rightLines } from '../../../src/core/review/review-build.js';
import { demoReview, demoReviewFiles } from '../../../src/server/demo/demo-reviews.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import type { PrReviewWire, ReviewSubmitInput } from '../../../src/core/api-types.js';

const at = new Date('2026-11-02T10:00:00Z');
const review = (): PrReviewWire => demoReview(at);
const HANDLER = 'src/Shop.Orders/Refunds/RefundHandler.cs';

describe('the lines a comment can go on', () => {
  it("a file's added and context lines, as ranges; unknown ranges (a review from before) accept any line", () => {
    const [f] = parseGitDiff(
      [
        'diff --git a/a.cs b/a.cs',
        '--- a/a.cs',
        '+++ b/a.cs',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        '@@ -10,1 +10,2 @@',
        ' x',
        '+y',
      ].join('\n'),
    );
    expect(rightLines(f)).toEqual([
      [1, 3],
      [10, 11],
    ]);
    expect(onDiffLine({ lines: [[1, 3]] }, 2)).toBe(true);
    expect(onDiffLine({ lines: [[1, 3]] }, 4)).toBe(false);
    expect(onDiffLine({}, 400)).toBe(true);
    expect(onDiffLine(undefined, 1)).toBe(false);
  });

  it('the demo review records them, and its AI note off the diff is set aside, not a draft', () => {
    const r = review();
    expect(r.files.find((f) => f.path === HANDLER)!.lines!.length).toBeGreaterThan(0);
    expect(r.drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(r.dropped).toEqual([expect.objectContaining({ path: 'src/Shop.Orders/Pricing/Rounding.cs', line: 90, by: 'ai' })]);
  });

  it('an AI answer that parses but names no story for the Logic files is a failed AI step, said so', () => {
    const r = buildReview(
      { repo: 'api', number: 1, title: 't', url: 'u', author: 'a', branch: 'b', base: 'main', headSha: 'h' },
      demoReviewFiles(),
      { whitespaceOnly: new Set(), generated: new Set() },
      JSON.stringify({ stories: [], notes: [] }),
    );
    expect(r).toMatchObject({ aiStep: 'failed', why: 'the AI step named no story: stories are by folder' });
    expect(r.stories.every((s) => s.by === 'folder')).toBe(true);
  });
});

describe('submit: what is refused', () => {
  const ok = (over: Partial<ReviewSubmitInput> = {}): ReviewSubmitInput => ({
    event: 'comment',
    body: '',
    drafts: [{ id: 'd1', body: 'x' }],
    ...over,
  });

  it('each refusal with its reason; a good one passes', () => {
    const r = review();
    expect(submitRefusal(r, ok())).toBeNull();
    expect(submitRefusal(r, null)).toBe('expected {event, body, drafts}');
    expect(submitRefusal(r, ok({ event: 'merge' as never }))).toBe('event must be comment, approve or request-changes');
    expect(submitRefusal(r, ok({ body: 'x'.repeat(20_001) }))).toBe('the summary is too long');
    expect(submitRefusal(r, { event: 'comment', body: '' })).toBe('expected drafts: [{id, body}]');
    expect(submitRefusal(r, ok({ drafts: [{ id: 'zz', body: 'x' }] }))).toBe('a draft that isn’t this review’s');
    expect(
      submitRefusal(
        r,
        ok({
          drafts: [
            { id: 'd1', body: 'x' },
            { id: 'd1', body: 'y' },
          ],
        }),
      ),
    ).toContain('is in it twice');
    expect(submitRefusal(r, ok({ drafts: [{ id: 'd1', body: '  ' }] }))).toContain('is empty or too long');
    expect(submitRefusal(r, ok({ drafts: [] }))).toBe('nothing to submit: no comment and no summary');
    expect(submitRefusal(r, ok({ event: 'request-changes', drafts: [] }))).toBe('say what to change: a comment or a summary');
    expect(submitRefusal(r, ok({ event: 'approve', drafts: [] }))).toBeNull();
    const posted = { ...r, drafts: r.drafts.map((d) => (d.id === 'd1' ? { ...d, state: 'posted' as const } : d)) };
    expect(submitRefusal(posted, ok())).toContain('was already posted');
  });

  it("a draft on a line the diff doesn't show is refused before it reaches the host (which would refuse the whole review)", () => {
    const r = review();
    const off = {
      ...r,
      drafts: [...r.drafts, { id: 'u1', path: HANDLER, line: 999, body: 'x', state: 'draft' as const, by: 'you' as const }],
    };
    expect(submitRefusal(off, ok({ drafts: [{ id: 'u1', body: 'x' }] }))).toContain("isn't on a line of the diff");
  });

  it('nothing is sent while a submit is in doubt', () => {
    const r = { ...review(), inDoubt: { at: at.toISOString(), event: 'comment' as const, drafts: [], summary: 'S', error: 'timed out' } };
    expect(submitRefusal(r, ok())).toContain('may have gone out');
  });
});

describe('submit: what went out', () => {
  const input: ReviewSubmitInput = {
    event: 'approve',
    body: 'Looks fine.',
    drafts: [
      { id: 'd1', body: 'first' },
      { id: 'd2', body: 'second' },
    ],
  };

  it('all of it: the drafts sent are posted with their text, the summary recorded', () => {
    const r = afterSubmit(review(), input, 'https://x/r/1', at);
    expect(r.drafts.map((d) => [d.id, d.state, d.body])).toEqual([
      ['d1', 'posted', 'first'],
      ['d2', 'posted', 'second'],
    ]);
    expect(r.submitted).toEqual({ at: at.toISOString(), event: 'approve', url: 'https://x/r/1', summary: 'Looks fine.' });
    expect(submitComments(review(), input).map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('part of it: the comments that went out are posted (never sent again), the summary that went out is not sent again', () => {
    const one = afterFailedSubmit(review(), input, { error: 'b: 500', posted: 1 }, at);
    expect(one.drafts.map((d) => [d.id, d.state])).toEqual([
      ['d1', 'posted'],
      ['d2', 'draft'],
    ]);
    expect(one.submitted).toMatchObject({ partial: true, event: 'approve' });
    expect(one.inDoubt).toBeUndefined();
    const votes = afterFailedSubmit(review(), input, { error: 'vote', posted: 2, summaryPosted: true }, at);
    expect(votes.submitted).toMatchObject({ partial: true, summary: 'Looks fine.' });
    // The retry: the vote alone — the summary already went out.
    expect(summaryToSend(votes, { event: 'approve', body: 'Looks fine.', drafts: [] })).toBe('');
    expect(summaryToSend(votes, { event: 'approve', body: 'Something else', drafts: [] })).toBe('Something else');
  });

  it('a clean refusal (nothing went out) changes nothing', () => {
    const r = review();
    const next = afterFailedSubmit(r, input, { error: '422' }, at);
    expect(next.drafts).toEqual(r.drafts);
    expect(next.submitted).toBeUndefined();
    expect(next.inDoubt).toBeUndefined();
  });

  it('a call that timed out: what it carried waits for your word — it went (posted), or it did not (cleared)', () => {
    const doubt = afterFailedSubmit(review(), input, { error: 'timed out', posted: 1, inDoubt: { comments: [1], summary: false } }, at);
    expect(doubt.drafts.map((d) => d.state)).toEqual(['posted', 'draft']);
    expect(doubt.inDoubt).toEqual({
      at: at.toISOString(),
      event: 'approve',
      drafts: [{ id: 'd2', body: 'second' }],
      summary: null,
      error: 'timed out',
    });
    const all = afterFailedSubmit(review(), input, { error: 'timed out', inDoubt: { comments: [0, 1], summary: true } }, at);
    expect(all.inDoubt).toMatchObject({ drafts: [{ id: 'd1' }, { id: 'd2' }], summary: 'Looks fine.' });

    const went = settleInDoubt(all, true, at)!;
    expect(went.inDoubt).toBeUndefined();
    expect(went.drafts.map((d) => d.state)).toEqual(['posted', 'posted']);
    expect(went.submitted).toMatchObject({ event: 'approve', summary: 'Looks fine.' });
    const didnt = settleInDoubt(all, false, at)!;
    expect(didnt.inDoubt).toBeUndefined();
    expect(didnt.drafts.map((d) => d.state)).toEqual(['draft', 'draft']);
    expect(settleInDoubt(review(), true, at)).toBeNull();
  });
});

describe('drafts: add, remove, carry over', () => {
  it('yours goes on a line the diff shows, of a file of the PR', () => {
    const r = review();
    const added = addDraft(r, { path: HANDLER, line: 6, body: 'mine' });
    expect('review' in added && added.review.drafts.at(-1)).toMatchObject({ id: 'u3', by: 'you', line: 6 });
    expect(addDraft(r, { path: HANDLER, line: 999, body: 'x' })).toEqual({
      error: "line 999 isn't in the diff: a review comment goes on a line it shows",
    });
    expect(addDraft(r, { path: 'nope.cs', line: 1, body: 'x' })).toEqual({ error: 'not a file of this PR' });
  });

  it('removed: a draft; never a posted one; an unknown one is 404', () => {
    const r = review();
    const out = removeDraft(r, 'd2');
    expect('review' in out && out.review.drafts.map((d) => d.id)).toEqual(['d1']);
    const posted = { ...r, drafts: r.drafts.map((d) => ({ ...d, state: 'posted' as const })) };
    expect(removeDraft(posted, 'd1')).toEqual({ error: 'it was posted: it stays as a record', status: 409 });
    expect(removeDraft(r, 'zz')).toEqual({ error: 'no such draft', status: 404 });
  });

  it('carried over: posted ones, yours on the new diff, what you submitted and a doubt; yours off it set aside; AI ids never reused', () => {
    const was: PrReviewWire = {
      ...review(),
      drafts: [
        { id: 'd1', path: HANDLER, line: 6, body: 'old AI, posted', state: 'posted', by: 'ai' },
        { id: 'd2', path: HANDLER, line: 7, body: 'old AI, unsent', state: 'draft', by: 'ai' },
        { id: 'u1', path: HANDLER, line: 6, body: 'mine', state: 'draft', by: 'you' },
        { id: 'u2', path: HANDLER, line: 999, body: 'mine, off', state: 'draft', by: 'you' },
      ],
      submitted: { at: at.toISOString(), event: 'comment' },
      inDoubt: { at: at.toISOString(), event: 'comment', drafts: [], summary: 'S', error: 'e' },
    };
    const next = carryForward(was, review());
    expect(next.drafts.map((d) => [d.id, d.body])).toEqual([
      ['d1', 'old AI, posted'],
      ['u1', 'mine'],
      ['d3', expect.stringContaining('two refunds at once')],
      ['d4', 'Nothing stops refunding more than the order total.'],
    ]);
    expect(next.lastDraft).toBe(4);
    expect(next.dropped!.map((d) => [d.by, d.body, d.why])).toEqual([
      ['you', 'mine, off', "line 999 isn't in the new diff"],
      ['ai', expect.any(String), expect.stringContaining("isn't in the diff")],
    ]);
    expect(next.submitted).toEqual(was.submitted);
    expect(next.inDoubt).toEqual(was.inDoubt);
    expect(carryForward(null, review())).toEqual(review());
    expect(clearDropped(next).dropped).toBeUndefined();
  });

  it('a submit in doubt names d1 and d2; prepared again, they stay as they were and new drafts never take their ids', () => {
    const doubt = afterFailedSubmit(
      review(),
      {
        event: 'comment',
        body: '',
        drafts: [
          { id: 'd1', body: 'sent text 1' },
          { id: 'd2', body: 'sent text 2' },
        ],
      },
      { error: 'gh: HTTP 502', inDoubt: { comments: [0, 1], summary: false } },
      at,
    );
    // A new push, or Prepare again: the AI step's new notes.
    const next = carryForward(doubt, review());
    const ids = next.drafts.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['d1', 'd2', 'd3', 'd4']);
    expect(next.drafts.slice(2).every((d) => d.state === 'draft' && d.by !== 'you')).toBe(true);
    // "It went out": only the drafts it sent are posted, with the text sent — never the new ones.
    const went = settleInDoubt(next, true, at)!;
    expect(went.drafts.map((d) => [d.id, d.state])).toEqual([
      ['d1', 'posted'],
      ['d2', 'posted'],
      ['d3', 'draft'],
      ['d4', 'draft'],
    ]);
    expect(went.drafts[0].body).toBe('sent text 1');
    // A draft of yours after a draft was removed never takes the removed id either.
    const removed = removeDraft(went, 'd4');
    const mine = 'review' in removed ? addDraft(removed.review, { path: HANDLER, line: 6, body: 'mine' }) : null;
    expect(mine && 'review' in mine && mine.review.drafts.at(-1)!.id).toBe('u5');
    // A draft a submit in doubt names can't be discarded until you say.
    expect(removeDraft(doubt, 'd1')).toEqual({ error: 'a submit may have sent it: say whether it went out first', status: 409 });
  });

  it('your drafts set aside before survive a re-prepare, beside the new ones set aside; the AI step’s old ones go', () => {
    const was: PrReviewWire = {
      ...review(),
      dropped: [
        { path: HANDLER, line: 999, body: 'mine, set aside before', by: 'you', why: "line 999 isn't in the new diff" },
        { path: HANDLER, line: 998, body: 'old AI, set aside', by: 'ai', why: 'x' },
      ],
    };
    const next = carryForward(was, review());
    expect(next.dropped!.map((d) => [d.by, d.body])).toEqual([
      ['you', 'mine, set aside before'],
      ['ai', expect.any(String)], // the fresh run's own
    ]);
    expect(next.dropped!.some((d) => d.body === 'old AI, set aside')).toBe(false);
  });

  it('lastDraftNumber: the recorded one, or the highest id the review names (drafts, a doubt, a claim)', () => {
    const r = review();
    expect(lastDraftNumber(r)).toBe(2);
    expect(lastDraftNumber({ ...r, lastDraft: 9 })).toBe(9);
    expect(
      lastDraftNumber({ ...r, inDoubt: { at: '', event: 'comment', drafts: [{ id: 'u7', body: '' }], summary: null, error: '' } }),
    ).toBe(7);
  });
});

describe('Azure DevOps: a doubtful step with steps after it', () => {
  const input: ReviewSubmitInput = {
    event: 'approve',
    body: 'Looks fine.',
    drafts: [
      { id: 'd1', body: 'first' },
      { id: 'd2', body: 'second' },
    ],
  };

  it('the first comment in doubt, the rest never tried: "it went" is partial — no approve recorded that wasn’t cast', () => {
    const doubt = afterFailedSubmit(
      review(),
      input,
      { error: 'HTTP 504', posted: 0, inDoubt: { comments: [0], summary: false, rest: true } },
      at,
    );
    expect(doubt.submitted).toBeUndefined();
    expect(doubt.inDoubt).toMatchObject({ drafts: [{ id: 'd1' }], partial: true });
    const went = settleInDoubt(doubt, true, at)!;
    expect(went.submitted).toEqual({ at: at.toISOString(), event: 'approve', partial: true });
    expect(went.drafts.map((d) => d.state)).toEqual(['posted', 'draft']);
    // The retry sends the rest: d2, the summary (it never went), and the vote.
    expect(submitRefusal(went, { event: 'approve', body: 'Looks fine.', drafts: [{ id: 'd2', body: 'second' }] })).toBeNull();
    expect(summaryToSend(went, { event: 'approve', body: 'Looks fine.', drafts: [] })).toBe('Looks fine.');
  });

  it('the summary in doubt before the vote: "it went" records it, so the retry is the vote alone, never the summary twice', () => {
    const doubt = afterFailedSubmit(review(), input, { error: 'x', posted: 2, inDoubt: { comments: [], summary: true, rest: true } }, at);
    const went = settleInDoubt(doubt, true, at)!;
    expect(went.submitted).toMatchObject({ partial: true, summary: 'Looks fine.' });
    expect(summaryToSend(went, { event: 'approve', body: 'Looks fine.', drafts: [] })).toBe('');
    // The doubtful call was the last: "it went" is the whole review.
    const last = afterFailedSubmit(
      review(),
      { ...input, event: 'comment' },
      { error: 'x', posted: 2, inDoubt: { comments: [], summary: true } },
      at,
    );
    expect(settleInDoubt(last, true, at)!.submitted!.partial).toBeUndefined();
  });

  it('request changes whose vote failed after the comments went: the vote alone may be retried, with no summary', () => {
    const partly = afterFailedSubmit(
      review(),
      { event: 'request-changes', body: '', drafts: [{ id: 'd1', body: 'fix this' }] },
      { error: 'vote', posted: 1 },
      at,
    );
    expect(submitRefusal(partly, { event: 'request-changes', body: '', drafts: [] })).toBeNull();
    expect(submitRefusal(review(), { event: 'request-changes', body: '', drafts: [] })).toBe('say what to change: a comment or a summary');
    expect(nothingToSubmit(partly, 'comment', 0, '')).toBe(true);
  });
});

describe('the submit claim', () => {
  const self = { pid: 10, bootedAt: Date.parse('2026-11-02T08:00:00Z'), alive: (pid: number) => pid === 20 };
  const claim = (over: Partial<NonNullable<PrReviewWire['submitting']>> = {}) => ({
    at: '2026-11-02T09:59:00Z',
    pid: 20,
    event: 'comment' as const,
    drafts: [{ id: 'd1', body: 'x' }],
    summary: null,
    ...over,
  });

  it('stands while its process runs (this one or another); left over when it is gone, from before the boot, or too old', () => {
    expect(claimStale(claim(), at, self)).toBe(false);
    expect(claimStale(claim({ pid: 10 }), at, self)).toBe(false);
    expect(claimStale(claim({ pid: 30 }), at, self)).toBe(true);
    expect(claimStale(claim({ at: '2026-11-02T07:00:00Z' }), at, self)).toBe(true);
    expect(claimStale(claim({ at: '2026-11-02T09:00:00Z', pid: 10 }), at, { ...self, bootedAt: 0 })).toBe(true); // 60 min
    expect(claimStale(claim({ at: 'nope' }), at, self)).toBe(true);
  });

  it('withClaim records what it sends; one left over becomes a doubt; a refused or finished submit ends the claim', () => {
    const input: ReviewSubmitInput = { event: 'approve', body: ' S ', drafts: [{ id: 'd1', body: ' a ' }] };
    const claimed = withClaim(review(), input, 10, at);
    expect(claimed.submitting).toEqual({
      at: at.toISOString(),
      pid: 10,
      event: 'approve',
      drafts: [{ id: 'd1', body: 'a' }],
      summary: 'S',
    });
    expect(submitRefusal(claimed, input)).toBe('this review is being submitted already');
    expect(claimToDoubt(claimed, 'stopped').inDoubt).toEqual({
      at: at.toISOString(),
      event: 'approve',
      drafts: [{ id: 'd1', body: 'a' }],
      summary: 'S',
      error: 'stopped',
      partial: true,
    });
    expect(afterSubmit(claimed, input, undefined, at).submitting).toBeUndefined();
    expect(afterFailedSubmit(claimed, input, { error: '422' }, at).submitting).toBeUndefined();
    // Carried over a re-prepare, with the drafts it sends.
    expect(carryForward(claimed, review()).submitting).toEqual(claimed.submitting);
  });
});

describe('the day and a review left running', () => {
  it("prepared today counts the local day's; a running one older than the AI step's time is left over", () => {
    const r = review();
    const today = { ...r, preparedAt: '2026-11-02T09:00:00' };
    const yesterday = { ...r, preparedAt: '2026-11-01T09:00:00' };
    expect(preparedOn([today, yesterday, { ...r, preparedAt: undefined }], new Date('2026-11-02T18:00:00'))).toBe(1);
    expect(isStaleRunning({ status: 'running', at: '2026-11-02T09:00:00Z' }, new Date('2026-11-02T09:05:00Z'))).toBe(false);
    expect(isStaleRunning({ status: 'running', at: '2026-11-02T09:00:00Z' }, new Date('2026-11-02T09:11:00Z'))).toBe(true);
    expect(isStaleRunning({ status: 'ready', at: '2026-11-02T09:00:00Z' }, new Date('2026-11-03T09:00:00Z'))).toBe(false);
  });
});
