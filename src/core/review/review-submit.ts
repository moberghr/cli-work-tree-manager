import type { PrReviewWire, ReviewDraftWire, ReviewDroppedWire, ReviewEvent, ReviewFileWire, ReviewSubmitInput } from '../api-types.js';
import { dayKey } from '../conversations/work-time-view.js';
import { fixClaimActive } from './review-fix-rules.js';

/**
 * PURE — submitting a prepared review (#64): the drafts you kept (the AI
 * step's and your own, each with its text as you left it), a verdict and a
 * summary go out together as one review, in your name, only on your click.
 * What a submit that stopped part way already sent is recorded and never
 * sent again; one whose outcome isn't known (a call that failed without a
 * clear refusal) waits for you to say whether it went. Draft ids are never
 * handed out twice (`lastDraft`). Adding and removing a draft; carrying your drafts
 * and what you submitted over to a review prepared again. The routes, the
 * queue, the demo and the SPA share these rules.
 */

export const MAX_DRAFT = 20_000;
const EVENTS = new Set<ReviewEvent>(['comment', 'approve', 'request-changes']);

/**
 * A `running` review older than this is left over (work web stopped while preparing it): prepared again, and its
 * button works. Past the AI step's 3 minutes and a fetch.
 */
export const STALE_RUNNING_MS = 10 * 60_000;

/** A review left `running` by a work web that stopped while preparing it. */
export const isStaleRunning = (r: Pick<PrReviewWire, 'status' | 'at'>, now: Date): boolean =>
  r.status === 'running' && now.getTime() - Date.parse(r.at) > STALE_RUNNING_MS;

/** Reviews prepared on a local day (what the daily cap counts). */
export const preparedOn = (reviews: PrReviewWire[], now: Date): number => {
  const day = dayKey(now.getTime());
  return reviews.filter((r) => r.preparedAt && dayKey(Date.parse(r.preparedAt)) === day).length;
};

/** A line a review comment can go on: one the diff shows of that file (unknown ranges: any line). */
export function onDiffLine(file: Pick<ReviewFileWire, 'lines'> | undefined, line: number): boolean {
  if (!file) return false;
  if (!file.lines) return true;
  return file.lines.some(([a, b]) => line >= a && line <= b);
}

const fileOf = (r: PrReviewWire, path: string) => r.files.find((f) => f.path === path);

/** A draft id's number (`d3`, `u3` → 3); 0 for anything else. */
const draftNumber = (id: string): number => {
  const m = /^[du](\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
};

/**
 * The highest number a draft id of this review has had: the recorded one (`lastDraft`), and every id it still names —
 * its drafts, a submit in doubt, a submit under way (a review from before `lastDraft`). A new draft is numbered past it.
 */
export function lastDraftNumber(r: PrReviewWire): number {
  const ids = [
    ...r.drafts.map((d) => d.id),
    ...(r.inDoubt?.drafts ?? []).map((d) => d.id),
    ...(r.submitting?.drafts ?? []).map((d) => d.id),
  ];
  return ids.reduce((m, id) => Math.max(m, draftNumber(id)), r.lastDraft ?? 0);
}

/** The drafts a submit in doubt or under way names: they may be posted, so they stay as they are until it's known. */
export const heldIds = (r: PrReviewWire): Set<string> =>
  new Set([...(r.inDoubt?.drafts ?? []), ...(r.submitting?.drafts ?? [])].map((d) => d.id));

/**
 * Why nothing can be submitted for this review right now, whatever is sent; null when something can. The SPA's
 * submit bar reads it too: it is shown in every state (an approval needs no prepared review: one held for its size
 * or whose preparing failed can be approved), its buttons off with this as the reason.
 */
export function submitBlocked(r: PrReviewWire, now: Date = new Date()): string | null {
  if (r.inDoubt)
    return 'the last submit may have gone out (it failed without a clear answer): look at the PR, then say whether it went before sending anything again';
  if (r.submitting) return 'this review is being submitted already';
  // Fix it myself is making its session: the drafts it took may not go out as comments too.
  if (fixClaimActive(r, now)) return 'Fix it myself is taking drafts of it to a session: submit once that is done';
  // Its files, lines and drafts are the prepared diff's, and the head they're sent at is that one: not while a new
  // push is being prepared (that would put them on another commit).
  if (r.status === 'queued' || r.status === 'running') return 'it is being prepared again (a new push): submit once it is ready';
  return null;
}

/** A submit request as sent, checked; a reason when it can't go. */
export function submitRefusal(r: PrReviewWire, input: unknown, now: Date = new Date()): string | null {
  const blocked = submitBlocked(r, now);
  if (blocked) return blocked;
  const i = input as Partial<ReviewSubmitInput> | null;
  if (!i || typeof i !== 'object') return 'expected {event, body, drafts}';
  if (!EVENTS.has(i.event as ReviewEvent)) return 'event must be comment, approve or request-changes';
  if (typeof i.body !== 'string' || i.body.length > MAX_DRAFT) return 'the summary is too long';
  if (!Array.isArray(i.drafts)) return 'expected drafts: [{id, body}]';
  const byId = new Map(r.drafts.map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (const d of i.drafts) {
    const known = d && typeof d.id === 'string' ? byId.get(d.id) : undefined;
    if (!known) return 'a draft that isn’t this review’s';
    if (seen.has(known.id)) return `the comment on ${known.path}:${known.line} is in it twice`;
    seen.add(known.id);
    if (known.state === 'posted') return `the comment on ${known.path}:${known.line} was already posted`;
    if (typeof d.body !== 'string' || !d.body.trim() || d.body.length > MAX_DRAFT)
      return `the comment on ${known.path}:${known.line} is empty or too long`;
    if (!onDiffLine(fileOf(r, known.path), known.line))
      return `the comment on ${known.path}:${known.line} isn't on a line of the diff: the host would refuse the whole review`;
  }
  if (nothingToSubmit(r, i.event as ReviewEvent, i.drafts.length, i.body))
    return i.event === 'comment' ? 'nothing to submit: no comment and no summary' : 'say what to change: a comment or a summary';
  return null;
}

/**
 * Nothing to send for this verdict (the SPA's button reads it too): a comment needs a comment or a summary; request
 * changes too, unless a submit that stopped part way already said what to change (its vote alone may follow it).
 */
export function nothingToSubmit(r: Pick<PrReviewWire, 'submitted'>, event: ReviewEvent, drafts: number, body: string): boolean {
  if (event === 'approve' || drafts > 0 || body.trim()) return false;
  return event === 'comment' || !r.submitted?.partial;
}

/** The status a refusal answers with: 409 when the review's state stands in the way (try again later), else 400. */
export const refusalStatus = (r: PrReviewWire, now: Date = new Date()): 400 | 409 =>
  r.inDoubt || r.submitting || fixClaimActive(r, now) || r.status === 'queued' || r.status === 'running' ? 409 : 400;

/** The line comments to send, as the host takes them. */
export function submitComments(r: PrReviewWire, input: ReviewSubmitInput): Array<{ path: string; line: number; body: string }> {
  const byId = new Map(r.drafts.map((d) => [d.id, d]));
  return input.drafts.map((d) => {
    const known = byId.get(d.id)!;
    return { path: known.path, line: known.line, body: d.body.trim() };
  });
}

/** The summary to send: none when a submit that stopped part way already posted this very text. */
export function summaryToSend(r: PrReviewWire, input: ReviewSubmitInput): string {
  const body = input.body.trim();
  return r.submitted?.partial && r.submitted.summary === body ? '' : body;
}

/**
 * How long a submit's claim stands before it's taken as left over even though its process seems alive (a reused pid):
 * past many comments' calls at a minute each.
 */
export const SUBMIT_CLAIM_STALE_MS = 30 * 60_000;

/** The review claimed for this submit (in the transaction that checked it): what it sends, by whom. */
export function withClaim(r: PrReviewWire, input: ReviewSubmitInput, pid: number, now: Date): PrReviewWire {
  const summary = summaryToSend(r, input);
  return {
    ...r,
    submitting: {
      at: now.toISOString(),
      pid,
      event: input.event,
      drafts: input.drafts.map((d) => ({ id: d.id, body: d.body.trim() })),
      summary: summary || null,
    },
  };
}

/**
 * A claim left over: made before this machine booted, by a process that's gone, or older than
 * `SUBMIT_CLAIM_STALE_MS`. Its own process's claim (a submit still waiting for the host) stands until the time.
 */
export function claimStale(
  claim: NonNullable<PrReviewWire['submitting']>,
  now: Date,
  self: { pid: number; bootedAt: number; alive: (pid: number) => boolean },
): boolean {
  const at = Date.parse(claim.at);
  if (!Number.isFinite(at) || now.getTime() - at > SUBMIT_CLAIM_STALE_MS) return true;
  if (at < self.bootedAt) return true;
  return claim.pid !== self.pid && !self.alive(claim.pid);
}

/**
 * A claim left over by a work web that stopped while submitting: what it was sending may have gone out, so it's in
 * doubt (all of it, perhaps only in part) for you to say — never just dropped (a retry would post it twice).
 */
export function claimToDoubt(r: PrReviewWire, error: string): PrReviewWire {
  const { submitting: claim, ...rest } = r;
  if (!claim) return r;
  return {
    ...rest,
    inDoubt: { at: claim.at, event: claim.event, drafts: claim.drafts, summary: claim.summary, error, partial: true },
  };
}

/** What a stale claim shows as, for the Reviews tab (it's in doubt the moment it's settled or submitted over). Pure. */
export const shownDoubt = (r: PrReviewWire): PrReviewWire['inDoubt'] =>
  r.inDoubt ?? (r.submitting?.stale ? claimToDoubt(r, LEFT_OVER_SUBMIT).inDoubt : undefined);

/** What a claim left over says once it's taken as in doubt. */
export const LEFT_OVER_SUBMIT = 'work stopped while submitting it: it may have gone out';

/** Whose claims are left over: this process, when this machine booted, and whether a process still runs. */
export interface ClaimOwner {
  pid: number;
  bootedAt: number;
  alive: (pid: number) => boolean;
}

/**
 * The review as shown: a submit claim left over is marked `stale` (never stored), so the Reviews tab offers to settle
 * it ("it went" / "it didn't") instead of "Submitting…" for good. Pure.
 */
export function markStaleClaim(r: PrReviewWire, now: Date, self: ClaimOwner): PrReviewWire {
  if (!r.submitting || r.submitting.stale || !claimStale(r.submitting, now, self)) return r;
  return { ...r, submitting: { ...r.submitting, stale: true } };
}

/** A claim left over, taken as in doubt (`claimToDoubt`); null when there is no claim, or it still stands. Pure. */
export function leftOverToDoubt(r: PrReviewWire, now: Date, self: ClaimOwner): PrReviewWire | null {
  if (!r.submitting || !claimStale(r.submitting, now, self)) return null;
  return claimToDoubt(r, LEFT_OVER_SUBMIT);
}

const unclaimed = (r: PrReviewWire): PrReviewWire => {
  const { submitting: _done, ...rest } = r;
  return rest;
};

/** The review once submitted: the drafts sent are posted (with the text sent), the rest stay drafts. */
export function afterSubmit(r: PrReviewWire, input: ReviewSubmitInput, url: string | undefined, now: Date): PrReviewWire {
  const sent = new Map(input.drafts.map((d) => [d.id, d.body.trim()]));
  const { inDoubt: _settled, ...rest } = unclaimed(r);
  const body = input.body.trim();
  return {
    ...rest,
    drafts: r.drafts.map((d) => (sent.has(d.id) ? { ...d, body: sent.get(d.id)!, state: 'posted' as const, ...(url ? { url } : {}) } : d)),
    submitted: { at: now.toISOString(), event: input.event, ...(url ? { url } : {}), ...(body ? { summary: body } : {}) },
  };
}

/** What a failed submit says went out, and what may have. */
export interface SubmitFailure {
  error: string;
  /** The first N comments sent went out. */
  posted?: number;
  summaryPosted?: boolean;
  /**
   * A call that failed without a clear refusal: these (indexes into the comments sent) and perhaps the summary may have
   * gone out; `rest`: the steps after it weren't tried.
   */
  inDoubt?: { comments: number[]; summary: boolean; rest?: boolean };
}

/**
 * The review after a submit that failed: the comments that went out are posted (never sent again), a summary that
 * went out is recorded (not sent again), and what may have gone out — a bare verdict too — waits for you (`inDoubt`). A clean refusal
 * (nothing went out) leaves it as it was. The submit's claim ends either way.
 */
export function afterFailedSubmit(r0: PrReviewWire, input: ReviewSubmitInput, failure: SubmitFailure, now: Date): PrReviewWire {
  const r = unclaimed(r0);
  const posted = Math.max(0, Math.min(failure.posted ?? 0, input.drafts.length));
  const went = new Map(input.drafts.slice(0, posted).map((d) => [d.id, d.body.trim()]));
  const body = summaryToSend(r, input);
  const maybe = failure.inDoubt;
  const doubtful = (maybe?.comments ?? []).filter((i) => i >= posted && i < input.drafts.length).map((i) => input.drafts[i]);
  const anything = went.size > 0 || !!failure.summaryPosted;
  return {
    ...r,
    drafts: r.drafts.map((d) => (went.has(d.id) ? { ...d, body: went.get(d.id)!, state: 'posted' as const } : d)),
    ...(anything
      ? {
          submitted: {
            at: now.toISOString(),
            event: input.event,
            partial: true,
            ...(failure.summaryPosted && body ? { summary: body } : r.submitted?.summary ? { summary: r.submitted.summary } : {}),
          },
        }
      : {}),
    // Whenever the failure says it may have gone out — a bare verdict too (an Approve with no comment or summary): a
    // retry would cast it twice.
    ...(maybe
      ? {
          inDoubt: {
            at: now.toISOString(),
            event: input.event,
            drafts: doubtful.map((d) => ({ id: d.id, body: d.body.trim() })),
            summary: maybe?.summary && body ? body : null,
            error: failure.error,
            ...(maybe?.rest ? { partial: true } : {}),
          },
        }
      : {}),
  };
}

/**
 * You looked at the PR after a submit that may have gone out: it went (its comments are posted, its summary
 * recorded), or it didn't (nothing changes but the doubt). Null when nothing is in doubt. "It went" is complete only
 * when the doubtful call was all that was left: steps after it that weren't tried (Azure DevOps' later comments,
 * summary or vote) leave it partial — never a verdict recorded that wasn't cast.
 */
export function settleInDoubt(r: PrReviewWire, went: boolean, now: Date): PrReviewWire | null {
  if (!r.inDoubt) return null;
  const { inDoubt, ...rest } = r;
  if (!went) return rest;
  const sent = new Map(inDoubt.drafts.map((d) => [d.id, d.body]));
  return {
    ...rest,
    drafts: r.drafts.map((d) => (sent.has(d.id) ? { ...d, body: sent.get(d.id)!, state: 'posted' as const } : d)),
    submitted: {
      at: now.toISOString(),
      event: inDoubt.event,
      ...(inDoubt.partial ? { partial: true } : {}),
      ...(r.submitted?.url ? { url: r.submitted.url } : {}),
      ...(inDoubt.summary ? { summary: inDoubt.summary } : r.submitted?.summary ? { summary: r.submitted.summary } : {}),
    },
  };
}

/** A draft of your own on a line of the PR's new side; a reason when it can't be added. */
export function addDraft(r: PrReviewWire, input: unknown): { review: PrReviewWire } | { error: string } {
  const i = input as { path?: unknown; line?: unknown; body?: unknown } | null;
  const file = i && typeof i.path === 'string' ? fileOf(r, i.path) : undefined;
  if (!i || typeof i.path !== 'string' || !file) return { error: 'not a file of this PR' };
  if (typeof i.line !== 'number' || !Number.isInteger(i.line) || i.line < 1) return { error: 'a line of the new side, please' };
  if (!onDiffLine(file, i.line)) return { error: `line ${i.line} isn't in the diff: a review comment goes on a line it shows` };
  if (typeof i.body !== 'string' || !i.body.trim() || i.body.length > MAX_DRAFT) return { error: 'the comment is empty or too long' };
  // Numbered past every id this review has had: never one a submit in doubt (or under way) still names.
  const n = lastDraftNumber(r) + 1;
  return {
    review: {
      ...r,
      drafts: [...r.drafts, { id: `u${n}`, path: i.path, line: i.line, body: i.body.trim(), state: 'draft', by: 'you' }],
      lastDraft: n,
    },
  };
}

/** A draft taken off the review (never one already posted, nor one a submit may have sent); a reason when it can't be. */
export function removeDraft(r: PrReviewWire, id: string): { review: PrReviewWire } | { error: string; status: 404 | 409 } {
  const d = r.drafts.find((x) => x.id === id);
  if (!d) return { error: 'no such draft', status: 404 };
  if (d.state === 'posted') return { error: 'it was posted: it stays as a record', status: 409 };
  if (heldIds(r).has(id)) return { error: 'a submit may have sent it: say whether it went out first', status: 409 };
  if (fixClaimActive(r, new Date()) && r.fixing?.drafts.includes(id))
    return { error: 'Fix it myself is taking it to a session: once that is done', status: 409 };
  // The id is kept as used: a later draft never takes it.
  return { review: { ...r, drafts: r.drafts.filter((x) => x.id !== id), lastDraft: lastDraftNumber(r) } };
}

/**
 * A review prepared again (a new push, or Prepare again) keeps what is yours: your drafts that still go on a line of
 * the new diff (the rest set aside in `dropped` with their text and why), what you posted (as a record), what you
 * submitted, a submit in doubt or under way (and every draft it names, as it is: it may be posted), the drafts a Fix it
 * myself claim that stands is taking, and your drafts set aside before. The AI step's unsent drafts are replaced by the new ones, numbered past every id the review has
 * ever had (`lastDraft`), so no id is handed out twice — one a submit in doubt names is never a new draft's.
 */
export function carryForward(was: PrReviewWire | null, fresh: PrReviewWire, now: Date = new Date()): PrReviewWire {
  if (!was) return fresh;
  const files = new Map(fresh.files.map((f) => [f.path, f]));
  const held = heldIds(was);
  // The drafts Fix it myself is taking to a session stay as they are while its claim stands: replaced by new ids, it
  // would take none of them off, and the same comments would stay submittable.
  if (fixClaimActive(was, now)) for (const id of was.fixing?.drafts ?? []) held.add(id);
  const keep: ReviewDraftWire[] = [];
  // Yours set aside before stay; the AI step's are the new run's to say.
  const dropped: ReviewDroppedWire[] = (was.dropped ?? []).filter((d) => d.by === 'you');
  for (const d of was.drafts) {
    if (d.state === 'posted' || held.has(d.id)) keep.push(d);
    else if (d.by === 'you') {
      if (onDiffLine(files.get(d.path), d.line)) keep.push(d);
      else
        dropped.push({
          path: d.path,
          line: d.line,
          body: d.body,
          by: 'you',
          why: files.has(d.path) ? `line ${d.line} isn't in the new diff` : `${d.path} isn't changed by the PR any more`,
        });
    }
  }
  // Numbered past every id ever used: a d1 a submit in doubt names and a new d1 would be one draft to a settle.
  const base = lastDraftNumber(was);
  const ai = fresh.drafts.map((d, i) => ({ ...d, id: `d${base + i + 1}` }));
  const allDropped = [...dropped, ...(fresh.dropped ?? [])];
  return {
    ...fresh,
    drafts: [...keep, ...ai],
    lastDraft: base + ai.length,
    ...(allDropped.length ? { dropped: allDropped } : {}),
    ...(was.submitted ? { submitted: was.submitted } : {}),
    ...(was.inDoubt ? { inDoubt: was.inDoubt } : {}),
    ...(was.submitting ? { submitting: was.submitting } : {}),
    ...(was.fixingMyself?.length ? { fixingMyself: was.fixingMyself } : {}),
    ...(was.fixing ? { fixing: was.fixing } : {}),
    // The discussion read with this preparation; none read (the host couldn't say, or rested): the last one stays.
    ...(fresh.discussion ? { discussion: fresh.discussion } : was.discussion ? { discussion: was.discussion } : {}),
  };
}

/** Forget the drafts set aside (you copied what you wanted). */
export const clearDropped = (r: PrReviewWire): PrReviewWire => {
  const { dropped: _gone, ...rest } = r;
  return rest;
};
