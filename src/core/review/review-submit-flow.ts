import type { PrReviewWire, ReviewEvent, ReviewSubmitInput } from '../api-types.js';
import type { SubmitReviewResult } from '../hosts/types.js';
import {
  afterFailedSubmit,
  afterSubmit,
  claimStale,
  claimToDoubt,
  refusalStatus,
  submitComments,
  submitRefusal,
  summaryToSend,
  withClaim,
} from './review-submit.js';

/**
 * Submitting a prepared review (#64), the whole of it: checked, claimed, sent to the host, recorded — the one flow
 * work web's route and the demo run, with its I/O passed in. Only on your click.
 *
 * - The claim is durable: `submitting` in the review's `pr_reviews` row, set in the same transaction that checked
 *   the submit, so a second one — another window, the dev server on the same state.db — is refused while it stands.
 *   One left by a work web that stopped (its process gone, made before this boot, or older than
 *   `SUBMIT_CLAIM_STALE_MS`) is taken as in doubt: what it sent may have gone out.
 * - The host's call: whatever it throws is a submit whose outcome isn't known — in doubt, never "nothing went out".
 * - Recorded in one transaction with the claim's end: what went out is posted, what may have waits for your word.
 */

export interface SubmitFlowDeps {
  read: (repo: string, number: number) => PrReviewWire | null;
  /** Change a stored review in one transaction; null when there is none. */
  update: (repo: string, number: number, change: (r: PrReviewWire) => PrReviewWire) => PrReviewWire | null;
  /** A repo alias's folder (where its host CLI runs). */
  repoPath: (alias: string) => string | null;
  submit: (
    repoPath: string,
    number: number,
    review: { commitId: string; event: ReviewEvent; body: string; comments: Array<{ path: string; line: number; body: string }> },
  ) => Promise<SubmitReviewResult>;
  /** This process (the claim's owner). */
  pid: number;
  /** When this machine booted (ms): a claim from before is left over. */
  bootedAt: () => number;
  /** A process still runs (a claim of one that doesn't is left over). */
  alive: (pid: number) => boolean;
  now?: () => Date;
}

export type SubmitFlowResult =
  | { ok: true; review: PrReviewWire }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: string;
      /** The review as it now stands, when this call changed it (a submit that failed, a left-over claim taken as in doubt). */
      review?: PrReviewWire;
    };

export async function submitPrReview(deps: SubmitFlowDeps, repo: string, number: number, input: unknown): Promise<SubmitFlowResult> {
  const now = () => deps.now?.() ?? new Date();
  const at = deps.repoPath(repo);
  if (!at || !deps.read(repo, number)) return { ok: false, status: 404, error: 'no review of that PR' };

  // Checked and claimed in one transaction: two submits at once — in this process or another — can't both pass.
  const got: { sending?: PrReviewWire; refused?: { status: 400 | 409; error: string }; changed?: boolean } = {};
  const claimed = deps.update(repo, number, (cur) => {
    let r = cur;
    if (r.submitting) {
      if (!claimStale(r.submitting, now(), { pid: deps.pid, bootedAt: deps.bootedAt(), alive: deps.alive })) {
        got.refused = { status: 409, error: 'this review is being submitted already' };
        return cur;
      }
      r = claimToDoubt(r, 'work stopped while submitting it: it may have gone out');
      got.changed = true;
    }
    const why = submitRefusal(r, input);
    if (why) {
      got.refused = { status: refusalStatus(r), error: why };
      return r;
    }
    got.sending = r;
    return withClaim(r, input as ReviewSubmitInput, deps.pid, now());
  });
  if (!claimed) return { ok: false, status: 404, error: 'no review of that PR' };
  if (got.refused || !got.sending)
    return { ok: false, ...(got.refused ?? { status: 409, error: 'refused' }), ...(got.changed ? { review: claimed } : {}) };

  const sending = got.sending;
  const ok = input as ReviewSubmitInput;
  const body = summaryToSend(sending, ok);
  const comments = submitComments(sending, ok);
  let res: SubmitReviewResult;
  try {
    res = await deps.submit(at, number, { commitId: sending.headSha, event: ok.event, body, comments });
  } catch (err) {
    // Whatever threw, it may have done so after the host took the review: in doubt, for you to look and say.
    res = {
      ok: false,
      error: `couldn't tell whether it went out: ${(err as Error).message}`,
      inDoubt: { comments: comments.map((_, i) => i), summary: !!body, rest: true },
    };
  }
  const result = res;
  const next = deps.update(repo, number, (was) =>
    result.ok ? afterSubmit(was, ok, result.url, now()) : afterFailedSubmit(was, ok, result, now()),
  );
  if (!next) return { ok: false, status: 404, error: 'the review went away while it was submitted' };
  // What went out before it stopped is recorded (never sent again); what may have, waits for your word.
  return result.ok ? { ok: true, review: next } : { ok: false, status: 409, error: result.error, review: next };
}
