import type { PrReviewWire } from '../api-types.js';
import type { StoredLocalReview } from './local-review.js';
import { asData } from '../time/fence.js';
import { describeReview } from './review-build.js';
import { NOTE_LEVEL_LABEL, VERDICT_LABEL } from './review-plan.js';

/**
 * The Reviews tab's reviews as text, for `work review` (a terminal, another session's agent, the Ctrl+K assistant):
 * the list a line each, and one review in full — what the tab shows, with each draft comment's own words, which the
 * assistant's description only counts. Pure. A PR's text is its author's and the AI step's reading of it: fenced
 * between <<< and >>> as data, never instructions (`asData`), as in `describeReview`.
 */

/** How long a draft comment may run in the text (the tab shows the whole). */
const MAX_DRAFT = 1500;

/** "api #231  ready  Refunds can be cancelled (@ana) · 4 stories · 2 drafts · 1 untested", newest first. */
export function reviewListLines(reviews: readonly PrReviewWire[]): string[] {
  return [...reviews]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => {
      const drafts = r.drafts.filter((d) => d.state === 'draft').length;
      const bits = [
        r.status === 'ready' ? `${r.stories.length} ${r.stories.length === 1 ? 'story' : 'stories'}` : (r.why ?? ''),
        drafts ? `${drafts} draft${drafts === 1 ? '' : 's'}` : '',
        r.tests.gaps.length ? `${r.tests.gaps.length} untested` : '',
      ].filter(Boolean);
      return `${r.repo} #${r.number}  ${r.status}  <<< ${asData(r.title, 120)} >>> (@${asData(r.author, 60)})${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
    });
}

/** One review in full: where it stands, its stories, what changed in each file, the discussion, and each draft comment. */
export function reviewText(r: PrReviewWire): string {
  // The assistant's description, without its first line (which speaks of the tab on screen).
  const [, ...described] = describeReview(r).split('\n');
  const drafts = r.drafts.filter((d) => d.state === 'draft');
  const posted = r.drafts.length - drafts.length;
  const local = r.number === 0;
  return [
    // Number 0: a session's own changes (local-review.ts), which are no pull request and go to no host.
    `${local ? `${r.repo}, your local changes` : `${r.repo} PR #${r.number} by @${asData(r.author, 60)}`}: ${r.status}${r.why ? ` (${r.why})` : ''}`,
    ...(r.url ? [r.url] : []),
    `${r.branch} → ${r.base} at ${r.headSha.slice(0, 8)}`,
    ...described,
    ...(drafts.length
      ? [
          local
            ? 'Notes (posted nowhere: the user can hand them to the session’s agent from its Review tab):'
            : 'Draft comments (not posted: they go out only with the user’s Submit in the Reviews tab):',
          ...drafts.map(
            (d) =>
              `- [${d.id}] ${asData(d.path, 160)}:${d.line} (${d.by === 'you' ? 'yours' : 'the AI step'}${d.level ? `; ${NOTE_LEVEL_LABEL[d.level].toLowerCase()}` : ''}): <<< ${asData(d.body, MAX_DRAFT)} >>>`,
          ),
        ]
      : []),
    ...(posted ? [`${posted} comment${posted === 1 ? ' is' : 's are'} already posted.`] : []),
  ].join('\n');
}

/**
 * A session's own review as it is kept (its Review tab), in full, for `work review session` (reported: a session's
 * agent asked to "check work review" looked at its comments and found none — the review isn't a comment, and it had
 * no way to read it). The notes you dismissed are left out (you didn't agree with them); the ones already handed to
 * the agent are said. Pure.
 */
export function sessionReviewText(kept: StoredLocalReview): string {
  const gone = new Set(kept.dismissed);
  const review = { ...kept.prepared.review, drafts: kept.prepared.review.drafts.filter((d) => !gone.has(d.id)) };
  const left = new Set(review.drafts.filter((d) => d.state === 'draft').map((d) => d.id));
  const sent = kept.sent.filter((id) => left.has(id));
  return [
    `Prepared ${kept.at}${kept.prepared.how ? ` (${kept.prepared.how})` : ''}; of ${kept.repo ?? `all its repos with changes (${kept.repos.join(', ')})`}.`,
    reviewText(review),
    ...(sent.length ? [`Already handed to this session's agent: ${sent.map((id) => `[${id}]`).join(' ')}.`] : []),
    ...(gone.size
      ? [`${gone.size} note${gone.size === 1 ? '' : 's'} the user dismissed ${gone.size === 1 ? 'is' : 'are'} not listed.`]
      : []),
  ].join('\n');
}

/**
 * What the notification of a review you asked for says (reported: after Prepare again nothing said it was done).
 * Ready: its recommendation when it has one, its stories and draft comments. Failed: why. Pure.
 */
export function reviewNotifyText(
  repo: string,
  number: number,
  r: { ok: true; review: Pick<PrReviewWire, 'recommendation' | 'stories' | 'drafts' | 'title'> } | { ok: false; error: string },
): { title: string; body: string } {
  if (!r.ok) return { title: `${repo} #${number}: review failed`, body: r.error };
  const notes = r.review.drafts.filter((d) => d.state === 'draft').length;
  const parts = [
    r.review.recommendation ? VERDICT_LABEL[r.review.recommendation.verdict] : '',
    `${r.review.stories.length} ${r.review.stories.length === 1 ? 'story' : 'stories'}`,
    `${notes} draft comment${notes === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return { title: `${repo} #${number}: review ready`, body: `${r.review.title.slice(0, 80)} — ${parts.join(' · ')}` };
}
