import { json, tx, withDb } from '../platform/db.js';
import type { PrReviewWire, ReviewFixWire } from '../api-types.js';
import { isDiscussion } from './review-discussion.js';

/**
 * Prepared reviews, one per PR (`repo#number`), in state.db `pr_reviews`
 * (schema v11). A row is the review for one head commit; a new push queues
 * it again. Not a session's state: a PR is reviewed whether or not a session
 * is on it, and its row goes when the PR is no longer open (`keepOnly`).
 * Rows are parsed as unknown and shape-checked (`isReview`), never cast.
 */

export const reviewKey = (repo: string, number: number) => `${repo}#${number}`;

const STATUSES = new Set(['queued', 'running', 'ready', 'waiting', 'failed']);

/** A stored review as written here; anything else is dropped. */
export function isReview(v: unknown): v is PrReviewWire {
  const r = v as Partial<PrReviewWire> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.repo === 'string' &&
    typeof r.number === 'number' &&
    typeof r.title === 'string' &&
    typeof r.url === 'string' &&
    typeof r.headSha === 'string' &&
    typeof r.status === 'string' &&
    STATUSES.has(r.status) &&
    typeof r.at === 'string' &&
    !!r.size &&
    typeof r.size.files === 'number' &&
    Array.isArray(r.files) &&
    r.files.every((f) => !!f && typeof f === 'object' && (f.summary === undefined || typeof f.summary === 'string')) &&
    !!r.tests &&
    Array.isArray(r.tests.list) &&
    Array.isArray(r.tests.gaps) &&
    Array.isArray(r.stories) &&
    r.stories.every(
      (s) => !!s && typeof s === 'object' && typeof s.title === 'string' && (s.what === undefined || typeof s.what === 'string'),
    ) &&
    Array.isArray(r.drafts) &&
    Array.isArray(r.unstoried) &&
    (r.summary === undefined || typeof r.summary === 'string') &&
    (r.dropped === undefined || Array.isArray(r.dropped)) &&
    (r.inDoubt === undefined || (!!r.inDoubt && Array.isArray(r.inDoubt.drafts) && typeof r.inDoubt.at === 'string')) &&
    (r.submitting === undefined ||
      (!!r.submitting &&
        typeof r.submitting.at === 'string' &&
        typeof r.submitting.pid === 'number' &&
        Array.isArray(r.submitting.drafts))) &&
    (r.lastDraft === undefined || typeof r.lastDraft === 'number') &&
    (r.fork === undefined || r.fork === true) &&
    (r.discussion === undefined || isDiscussion(r.discussion)) &&
    (r.fixingMyself === undefined || (Array.isArray(r.fixingMyself) && r.fixingMyself.every(isFix))) &&
    (r.fixing === undefined ||
      (!!r.fixing &&
        typeof r.fixing.at === 'string' &&
        Array.isArray(r.fixing.drafts) &&
        r.fixing.drafts.every((d) => typeof d === 'string')))
  );
}

/** One batch of drafts taken off to fix yourself, as written here. */
function isFix(v: unknown): boolean {
  const f = v as Partial<ReviewFixWire> | null;
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.at === 'string' &&
    typeof f.sessionId === 'string' &&
    typeof f.branch === 'string' &&
    Array.isArray(f.comments) &&
    f.comments.every(
      (c) =>
        !!c &&
        typeof c === 'object' &&
        typeof c.path === 'string' &&
        typeof c.line === 'number' &&
        typeof c.body === 'string' &&
        (c.by === undefined || c.by === 'ai' || c.by === 'you'),
    )
  );
}

export function readReview(repo: string, number: number): PrReviewWire | null {
  return withDb((d) => {
    const row = d.prepare('SELECT data FROM pr_reviews WHERE key = ?').get(reviewKey(repo, number)) as { data: string } | undefined;
    const v = row ? json.parse(row.data) : null;
    return isReview(v) ? v : null;
  });
}

export function allReviews(): PrReviewWire[] {
  return withDb((d) =>
    (d.prepare('SELECT data FROM pr_reviews').all() as Array<{ data: string }>).map((r) => json.parse(r.data)).filter(isReview),
  );
}

export function writeReview(r: PrReviewWire): void {
  withDb((d) =>
    d.prepare('INSERT OR REPLACE INTO pr_reviews (key, data) VALUES (?, ?)').run(reviewKey(r.repo, r.number), JSON.stringify(r)),
  );
}

/** Change a stored review in one transaction (a draft posted, a status moved); null when there is none. */
export function updateReview(repo: string, number: number, change: (r: PrReviewWire) => PrReviewWire): PrReviewWire | null {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM pr_reviews WHERE key = ?').get(reviewKey(repo, number)) as { data: string } | undefined;
    const was = row ? json.parse(row.data) : null;
    if (!isReview(was)) return null;
    const next = change(was);
    d.prepare('INSERT OR REPLACE INTO pr_reviews (key, data) VALUES (?, ?)').run(reviewKey(repo, number), JSON.stringify(next));
    return next;
  });
}

/** Read and write one review in one transaction (`change` gets what is stored, null when none): what was written. */
export function upsertReview(repo: string, number: number, change: (was: PrReviewWire | null) => PrReviewWire): PrReviewWire {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM pr_reviews WHERE key = ?').get(reviewKey(repo, number)) as { data: string } | undefined;
    const was = row ? json.parse(row.data) : null;
    const next = change(isReview(was) ? was : null);
    d.prepare('INSERT OR REPLACE INTO pr_reviews (key, data) VALUES (?, ?)').run(reviewKey(repo, number), JSON.stringify(next));
    return next;
  });
}

/**
 * Drop the reviews of PRs no longer open (`open`: the keys still open, per repo asked); repos not asked keep theirs.
 * The ones dropped, for their fetched code to go too.
 */
export function keepOnly(repos: string[], open: Set<string>): Array<{ repo: string; number: number }> {
  const asked = new Set(repos);
  return tx((d) => {
    const gone: Array<{ repo: string; number: number }> = [];
    for (const r of d.prepare('SELECT key, data FROM pr_reviews').all() as Array<{ key: string; data: string }>) {
      const v = json.parse(r.data);
      const hash = r.key.lastIndexOf('#');
      const repo = isReview(v) ? v.repo : r.key.slice(0, hash);
      const number = isReview(v) ? v.number : Number(r.key.slice(hash + 1));
      if (asked.has(repo) && !open.has(r.key)) {
        d.prepare('DELETE FROM pr_reviews WHERE key = ?').run(r.key);
        gone.push({ repo, number });
      }
    }
    return gone;
  });
}
