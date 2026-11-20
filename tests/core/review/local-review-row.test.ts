import { describe, expect, it } from 'vitest';
import { createLocalReviews, localReviewLine, prepareLocalReview, type PreparedLocal } from '../../../src/core/review/local-review.js';
import { dropLocalReview, readLocalReview, saveLocalReview } from '../../../src/core/review/local-review-store.js';
import { inboxRank, owedToYou, reviewWantsYou, wantsYou } from '../../../src/core/status/attention.js';
import { OWED_LONG, OWED_SHORT } from '../../../src/core/sessions/session-view.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** A session's finished review is something it owes you (asked for: a review takes minutes, and nothing said it was done). */
const FILE = 'src/Shop.Core/Handlers/RefundHandler.cs';
const files = parseGitDiff(
  [
    `diff --git a/${FILE} b/${FILE}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${FILE}`,
    '@@ -0,0 +1,2 @@',
    '+class A {',
    '+}',
    '',
  ].join('\n'),
);
const session = {
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/wt/x'],
  createdAt: 'x',
  lastAccessedAt: 'x',
} as WorktreeSession;
const answer = JSON.stringify({
  recommendation: { verdict: 'fix-first', text: 'Fix the limit.' },
  stories: [{ title: 'A class.', why: 'W', risk: 'R', riskLevel: 3, flags: [], files: [FILE] }],
  notes: [
    { path: FILE, line: 1, body: 'First.' },
    { path: FILE, line: 2, body: 'Second.' },
  ],
});
const prepared = (): Promise<PreparedLocal> =>
  prepareLocalReview(session, undefined, {
    diff: () => ({ repos: [{ name: 'api', files }], resolvedBase: 'origin/main' }),
    agent: async () => answer,
  });
const flush = () => new Promise((r) => setTimeout(r, 0));
const store = { read: readLocalReview, save: saveLocalReview, drop: dropLocalReview };

describe('what its row says', () => {
  it('the verdict, the stories and the notes when ready; why when it failed; that it is being prepared', async () => {
    const p = await prepared();
    expect(localReviewLine({ status: 'ready', review: p.review })).toBe('Review ready: Fix first · 1 story · 2 notes');
    expect(localReviewLine({ status: 'ready', review: { ...p.review, recommendation: undefined, drafts: [] } })).toBe(
      'Review ready: 1 story · 0 notes',
    );
    expect(localReviewLine({ status: 'failed', error: 'Nothing has changed on this branch since origin/main.' })).toBe(
      'Review couldn’t be prepared: Nothing has changed on this branch since origin/main.',
    );
    expect(localReviewLine({ status: 'running' })).toBe('Preparing its review…');
  });
});

describe('the row of a session’s review', () => {
  it('none; being prepared (nothing to see yet); ready and unseen; seen once you looked', async () => {
    const reviews = createLocalReviews({ prepare: prepared, onChange: () => {} });
    expect(reviews.row('s1')).toBeNull();
    reviews.start('s1', session, undefined);
    expect(reviews.row('s1')).toEqual({ status: 'running', seen: true, line: 'Preparing its review…' });
    await flush();
    await flush();
    expect(reviews.row('s1')).toEqual({ status: 'ready', seen: false, line: 'Review ready: Fix first · 1 story · 2 notes' });
    expect(reviews.markSeen('s1')).toBe(true);
    expect(reviews.row('s1')?.seen).toBe(true);
    // Already seen, or none: nothing to mark.
    expect(reviews.markSeen('s1')).toBe(false);
    expect(reviews.markSeen('nope')).toBe(false);
  });

  it('a review that couldn’t be prepared is said too, until you look', async () => {
    const reviews = createLocalReviews({ prepare: async () => Promise.reject(new Error('no changes')), onChange: () => {} });
    reviews.start('s1', session, undefined);
    await flush();
    expect(reviews.row('s1')).toEqual({ status: 'failed', seen: false, line: 'Review couldn’t be prepared: no changes' });
    expect(reviews.markSeen('s1')).toBe(true);
    expect(reviews.row('s1')?.seen).toBe(true);
  });

  it('after a restart: unseen is still unseen, seen still seen; a review kept from before counts as seen; the store is read once', async () => {
    const first = createLocalReviews({ prepare: prepared, onChange: () => {}, store });
    first.start('s2', session, undefined);
    await flush();
    await flush();
    let reads = 0;
    const counting = { ...store, read: (id: string) => (reads++, readLocalReview(id)) };
    const second = createLocalReviews({ prepare: prepared, onChange: () => {}, store: counting });
    expect(second.row('s2')).toEqual({ status: 'ready', seen: false, line: 'Review ready: Fix first · 1 story · 2 notes' });
    second.row('s2');
    second.row('none-here');
    second.row('none-here');
    // One read each: a stored review is large, and the sessions list asks often.
    expect(reads).toBe(2);
    expect(second.markSeen('s2')).toBe(true);
    expect(createLocalReviews({ prepare: prepared, onChange: () => {}, store }).row('s2')?.seen).toBe(true);
    // From before `seen` was recorded: not announced on upgrade.
    const old = readLocalReview('s2')!;
    saveLocalReview('s3', { ...old, seen: undefined });
    expect(createLocalReviews({ prepare: prepared, onChange: () => {}, store }).row('s3')?.seen).toBe(true);
  });
});

describe('the Inbox', () => {
  it('a finished, unseen review is owed to you and brings the session into "Needs you"; one being prepared or seen doesn’t', () => {
    const idle = { state: 'idle' as const, seen: true, since: '2026-11-19T10:00:00Z' };
    const ready = { attention: idle, localReview: { status: 'ready', seen: false } };
    expect(reviewWantsYou(ready)).toBe(true);
    expect(owedToYou(ready)).toEqual([{ kind: 'review', count: 1 }]);
    expect(inboxRank(ready)).toBe(2);
    expect(wantsYou(ready)).toBe(true);
    expect(reviewWantsYou({ localReview: { status: 'failed', seen: false } })).toBe(true);
    for (const localReview of [{ status: 'running', seen: true }, { status: 'ready', seen: true }, null, undefined]) {
      expect(reviewWantsYou({ localReview })).toBe(false);
      expect(inboxRank({ attention: idle, localReview })).toBe(4);
    }
    // Its Claude asking you something still comes first.
    expect(inboxRank({ attention: { ...idle, state: 'needs_input' }, localReview: { status: 'ready', seen: false } })).toBe(0);
    expect(OWED_SHORT.review(1)).toBe('review ready');
    expect(OWED_LONG.review(1)).toContain('Review tab');
  });
});
