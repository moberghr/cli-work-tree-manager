import type { PrReviewWire, ReviewDraftWire, ReviewDroppedWire, ReviewEvent, ReviewFileWire, ReviewSubmitInput } from '../api-types.js';
import { dayKey } from '../conversations/work-time-view.js';

/**
 * PURE — submitting a prepared review (#64): the drafts you kept (the AI
 * step's and your own, each with its text as you left it), a verdict and a
 * summary go out together as one review, in your name, only on your click.
 * What a submit that stopped part way already sent is recorded and never
 * sent again; one whose outcome isn't known (a timed-out call) waits for you
 * to say whether it went. Adding and removing a draft; carrying your drafts
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

/** A submit request as sent, checked; a reason when it can't go. */
export function submitRefusal(r: PrReviewWire, input: unknown): string | null {
  if (r.inDoubt)
    return 'the last submit may have gone out (it timed out): look at the PR, then say whether it went before sending anything again';
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
  if (i.event === 'comment' && !i.drafts.length && !i.body.trim()) return 'nothing to submit: no comment and no summary';
  if (i.event === 'request-changes' && !i.drafts.length && !i.body.trim()) return 'say what to change: a comment or a summary';
  return null;
}

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

/** The review once submitted: the drafts sent are posted (with the text sent), the rest stay drafts. */
export function afterSubmit(r: PrReviewWire, input: ReviewSubmitInput, url: string | undefined, now: Date): PrReviewWire {
  const sent = new Map(input.drafts.map((d) => [d.id, d.body.trim()]));
  const { inDoubt: _settled, ...rest } = r;
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
  /** A call that timed out: these (indexes into the comments sent) and perhaps the summary may have gone out. */
  inDoubt?: { comments: number[]; summary: boolean };
}

/**
 * The review after a submit that failed: the comments that went out are posted (never sent again), a summary that
 * went out is recorded (not sent again), and what may have gone out waits for you (`inDoubt`). A clean refusal
 * (nothing went out) leaves it as it was.
 */
export function afterFailedSubmit(r: PrReviewWire, input: ReviewSubmitInput, failure: SubmitFailure, now: Date): PrReviewWire {
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
    ...(doubtful.length || maybe?.summary
      ? {
          inDoubt: {
            at: now.toISOString(),
            event: input.event,
            drafts: doubtful.map((d) => ({ id: d.id, body: d.body.trim() })),
            summary: maybe?.summary && body ? body : null,
            error: failure.error,
          },
        }
      : {}),
  };
}

/**
 * You looked at the PR after a submit that may have gone out: it went (its comments are posted, its summary
 * recorded), or it didn't (nothing changes but the doubt). Null when nothing is in doubt.
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
      ...(r.submitted?.partial ? { partial: true } : {}),
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
  const n = r.drafts.filter((d) => d.id.startsWith('u')).reduce((m, d) => Math.max(m, Number(d.id.slice(1)) || 0), 0) + 1;
  return {
    review: { ...r, drafts: [...r.drafts, { id: `u${n}`, path: i.path, line: i.line, body: i.body.trim(), state: 'draft', by: 'you' }] },
  };
}

/** A draft taken off the review (never one already posted); a reason when it can't be. */
export function removeDraft(r: PrReviewWire, id: string): { review: PrReviewWire } | { error: string; status: 404 | 409 } {
  const d = r.drafts.find((x) => x.id === id);
  if (!d) return { error: 'no such draft', status: 404 };
  if (d.state === 'posted') return { error: 'it was posted: it stays as a record', status: 409 };
  return { review: { ...r, drafts: r.drafts.filter((x) => x.id !== id) } };
}

/**
 * A review prepared again (a new push, or Prepare again) keeps what is yours: your drafts that still go on a line of
 * the new diff (the rest set aside in `dropped` with their text and why), what you posted (as a record), what you
 * submitted, a submit in doubt, and your drafts set aside before. The AI step's unsent drafts are replaced by the new
 * ones, numbered after every kept id so none is taken twice.
 */
export function carryForward(was: PrReviewWire | null, fresh: PrReviewWire): PrReviewWire {
  if (!was) return fresh;
  const files = new Map(fresh.files.map((f) => [f.path, f]));
  const keep: ReviewDraftWire[] = [];
  // Yours set aside before stay; the AI step's are the new run's to say.
  const dropped: ReviewDroppedWire[] = (was.dropped ?? []).filter((d) => d.by === 'you');
  for (const d of was.drafts) {
    if (d.state === 'posted') keep.push(d);
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
  // Numbered past every kept AI id: a posted d1 and a new d1 would be one draft to the view and to a submit.
  const nextAi = keep.filter((d) => /^d\d+$/.test(d.id)).reduce((m, d) => Math.max(m, Number(d.id.slice(1))), 0);
  const ai = fresh.drafts.map((d, i) => ({ ...d, id: `d${nextAi + i + 1}` }));
  const allDropped = [...dropped, ...(fresh.dropped ?? [])];
  return {
    ...fresh,
    drafts: [...keep, ...ai],
    ...(allDropped.length ? { dropped: allDropped } : {}),
    ...(was.submitted ? { submitted: was.submitted } : {}),
    ...(was.inDoubt ? { inDoubt: was.inDoubt } : {}),
  };
}

/** Forget the drafts set aside (you copied what you wanted). */
export const clearDropped = (r: PrReviewWire): PrReviewWire => {
  const { dropped: _gone, ...rest } = r;
  return rest;
};
