import type { PrReviewWire } from '../api-types.js';
import { asData } from '../time/fence.js';
import { describeReview } from './review-build.js';
import { NOTE_LEVEL_LABEL } from './review-plan.js';

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
