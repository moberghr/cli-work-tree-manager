import type { PrReviewWire } from '../api-types.js';

/**
 * PURE, import-free — when Fix it myself may take a review's drafts (#64), shared by the flow (review-fix.ts), the
 * submit's check (review-submit.ts), the demo and the SPA's button (review-view.ts), so they never disagree.
 *
 * Fix it myself claims the drafts it takes (`fixing` in the review's row, set in the transaction that checked it)
 * while it makes the session — up to a minute or more —, so a submit, or a second Fix it myself from another window,
 * can't take the same drafts meanwhile. The claim ends with it (taken off, or released on a failure); one left by a
 * work web that stopped stands only `FIX_CLAIM_STALE_MS`.
 */

/** A Fix it myself claim older than this is left over (work web stopped mid-way): it no longer stands. Past a slow creation. */
export const FIX_CLAIM_STALE_MS = 10 * 60_000;

/** A Fix it myself claim stands (made, and not left over). */
export function fixClaimActive(r: Pick<PrReviewWire, 'fixing'>, now: Date): boolean {
  if (!r.fixing) return false;
  const at = Date.parse(r.fixing.at);
  return Number.isFinite(at) && now.getTime() - at <= FIX_CLAIM_STALE_MS;
}

/** Why the review's state keeps Fix it myself from taking drafts now (null: it doesn't), with the status it answers. */
export function fixStateRefusal(r: PrReviewWire, now: Date): { status: 409; error: string } | null {
  if (r.fork) return { status: 409, error: "it comes from a fork: its branch isn't on origin, so a session couldn't push to it" };
  if (r.inDoubt || r.submitting?.stale)
    return {
      status: 409,
      error: 'the last submit may have gone out: say whether it went first (it changes which drafts are still drafts)',
    };
  if (r.submitting) return { status: 409, error: 'this review is being submitted: its drafts are spoken for until it ends' };
  if (fixClaimActive(r, now)) return { status: 409, error: 'Fix it myself is making its session already: its drafts are spoken for' };
  if (r.status === 'queued' || r.status === 'running')
    return { status: 409, error: 'it is being prepared again (a new push): once it is ready' };
  return null;
}

/** Why Fix it myself can't take these drafts (null: it can), with the status it answers. */
export function fixRefusal(r: PrReviewWire, ids: string[], now: Date): { status: 400 | 409; error: string } | null {
  const state = fixStateRefusal(r, now);
  if (state) return state;
  if (!ids.length) return { status: 400, error: 'pick at least one comment to fix yourself' };
  const byId = new Map(r.drafts.map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) return { status: 400, error: 'a draft that isn’t this review’s' };
    if (seen.has(id)) return { status: 400, error: `the comment on ${d.path}:${d.line} is in it twice` };
    seen.add(id);
    if (d.state === 'posted') return { status: 409, error: `the comment on ${d.path}:${d.line} was already posted` };
  }
  return null;
}

/** The review with Fix it myself's claim on these drafts. */
export const withFixClaim = (r: PrReviewWire, ids: string[], now: Date): PrReviewWire => ({
  ...r,
  fixing: { at: now.toISOString(), drafts: [...ids] },
});

/** The review with Fix it myself's claim gone (it ended, either way). */
export function withoutFixClaim(r: PrReviewWire): PrReviewWire {
  const { fixing: _ended, ...rest } = r;
  return rest;
}
