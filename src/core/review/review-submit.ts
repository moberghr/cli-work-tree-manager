import type { PrReviewWire, ReviewEvent, ReviewSubmitInput } from '../api-types.js';

/**
 * PURE — submitting a prepared review (#64): the drafts you kept (the AI
 * step's and your own, each with its text as you left it), a verdict and a
 * summary go out together as one review, in your name, only on your click.
 * And adding a draft of your own on a line of the diff. The routes and the
 * demo share these rules.
 */

export const MAX_DRAFT = 20_000;
const EVENTS = new Set<ReviewEvent>(['comment', 'approve', 'request-changes']);

/** A submit request as sent, checked; a reason when it can't go. */
export function submitRefusal(r: PrReviewWire, input: unknown): string | null {
  const i = input as Partial<ReviewSubmitInput> | null;
  if (!i || typeof i !== 'object') return 'expected {event, body, drafts}';
  if (!EVENTS.has(i.event as ReviewEvent)) return 'event must be comment, approve or request-changes';
  if (typeof i.body !== 'string' || i.body.length > MAX_DRAFT) return 'the summary is too long';
  if (!Array.isArray(i.drafts)) return 'expected drafts: [{id, body}]';
  const byId = new Map(r.drafts.map((d) => [d.id, d]));
  for (const d of i.drafts) {
    const known = d && typeof d.id === 'string' ? byId.get(d.id) : undefined;
    if (!known) return 'a draft that isn’t this review’s';
    if (known.state === 'posted') return `the comment on ${known.path}:${known.line} was already posted`;
    if (typeof d.body !== 'string' || !d.body.trim() || d.body.length > MAX_DRAFT)
      return `the comment on ${known.path}:${known.line} is empty or too long`;
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

/** The review once submitted: the drafts sent are posted (with the text sent), the rest stay drafts. */
export function afterSubmit(r: PrReviewWire, input: ReviewSubmitInput, url: string | undefined, now: Date): PrReviewWire {
  const sent = new Map(input.drafts.map((d) => [d.id, d.body.trim()]));
  return {
    ...r,
    drafts: r.drafts.map((d) => (sent.has(d.id) ? { ...d, body: sent.get(d.id)!, state: 'posted' as const, ...(url ? { url } : {}) } : d)),
    submitted: { at: now.toISOString(), event: input.event, ...(url ? { url } : {}) },
  };
}

/** A draft of your own on a line of the PR's new side; a reason when it can't be added. */
export function addDraft(r: PrReviewWire, input: unknown): { review: PrReviewWire } | { error: string } {
  const i = input as { path?: unknown; line?: unknown; body?: unknown } | null;
  if (!i || typeof i.path !== 'string' || !r.files.some((f) => f.path === i.path)) return { error: 'not a file of this PR' };
  if (typeof i.line !== 'number' || !Number.isInteger(i.line) || i.line < 1) return { error: 'a line of the new side, please' };
  if (typeof i.body !== 'string' || !i.body.trim() || i.body.length > MAX_DRAFT) return { error: 'the comment is empty or too long' };
  const n = r.drafts.filter((d) => d.id.startsWith('u')).reduce((m, d) => Math.max(m, Number(d.id.slice(1)) || 0), 0) + 1;
  return {
    review: { ...r, drafts: [...r.drafts, { id: `u${n}`, path: i.path, line: i.line, body: i.body.trim(), state: 'draft', by: 'you' }] },
  };
}
