import type { Comment, CommentInput } from './client.js';
import type { ReviewApi } from './review-api.js';
import type { PrReviewWire } from '../../../core/api-types.js';
import { addReviewDraft, discardReviewDraft, fetchReview } from './panes.js';

/**
 * A prepared review's drafts as the diff's comment model (`ReviewProvider`),
 * so they show on their lines in the diff with the usual comment rows — the
 * AI step's labelled Claude, yours as yours — and a comment you add on a
 * line becomes a draft of the review. Nothing goes to the host from here:
 * the review is submitted as a whole from the tab's submit bar.
 */
export function draftsAsComments(r: PrReviewWire): Comment[] {
  return r.drafts
    .filter((d) => d.state === 'draft')
    .map((d) => ({
      id: d.id,
      repo: r.repo,
      file: d.path,
      line: d.line,
      side: 'right' as const,
      body: d.body,
      createdAt: r.preparedAt ?? r.at,
      author: d.by === 'you' ? ('user' as const) : ('claude' as const),
      status: 'draft' as const,
    }));
}

export function reviewDraftsApi(repo: string, number: number, onChange: (r: PrReviewWire) => void): ReviewApi {
  const now = async () => draftsAsComments(await fetchReview(repo, number));
  const after = (r: PrReviewWire) => {
    onChange(r);
    return { comments: draftsAsComments(r) };
  };
  return {
    fetch: now,
    post: async (input: CommentInput) => {
      // A comment on a line of the new side becomes a draft; a whole-file or general one has no line to go on.
      if (!input.file || !input.line) throw new Error('a review comment goes on a line of the new side');
      return after(await addReviewDraft(repo, number, { path: input.file, line: input.line, body: input.body }));
    },
    delete: async (id: string) => after(await discardReviewDraft(repo, number, id)),
    // A draft has no resolved state; the review's own submit bar sends them.
    resolve: async () => ({ comments: await now() }),
    submit: async () => ({ comments: await now(), count: 0 }),
    discard: async () => ({ comments: await now(), discarded: 0 }),
    done: async () => undefined,
    ssePath: '/events',
    matchesEvent: () => false,
    draftsOnly: true,
  };
}
