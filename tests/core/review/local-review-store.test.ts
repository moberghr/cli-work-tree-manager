import { describe, expect, it } from 'vitest';
import { createLocalReviews, prepareLocalReview, type PreparedLocal } from '../../../src/core/review/local-review.js';
import { dropLocalReview, isStoredLocalReview, readLocalReview, saveLocalReview } from '../../../src/core/review/local-review-store.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import { purgeSessionRows, tx } from '../../../src/core/platform/db.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** A session's own review outlives a restart (reported: it lived in memory, and a restart cost minutes to prepare it again). */
const FILE = 'src/Shop.Core/Handlers/RefundHandler.cs';
const files = parseGitDiff(
  [
    'diff --git a/' + FILE + ' b/' + FILE,
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/' + FILE,
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
const store = { read: readLocalReview, save: saveLocalReview, drop: dropLocalReview };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the stored review', () => {
  it('is written and read back whole; a row that isn’t a review is none; gone with the session', async () => {
    const p = await prepared();
    expect(readLocalReview('s1')).toBeNull();
    saveLocalReview('s1', { repo: 'api', repos: ['api'], prepared: p, at: '2026-11-17T10:00:00.000Z', sent: ['d1'], dismissed: [] });
    const back = readLocalReview('s1')!;
    expect(back.prepared.review.headSha).toBe(p.review.headSha);
    expect(back.prepared.files.map((f) => f.path)).toEqual([FILE]);
    expect(back.sent).toEqual(['d1']);
    expect(isStoredLocalReview({ ...back, prepared: { review: {} } })).toBe(false);
    expect(isStoredLocalReview({ ...back, sent: 'd1' })).toBe(false);
    expect(isStoredLocalReview(null)).toBe(false);
    tx((d) => purgeSessionRows(d, 's1'));
    expect(readLocalReview('s1')).toBeNull();
  });
});

describe('createLocalReviews with a store', () => {
  it('a ready review is there after a restart, with what was sent and dismissed', async () => {
    const first = createLocalReviews({ prepare: prepared, onChange: () => {}, store });
    first.start('s2', session, undefined);
    await flush();
    await flush();
    expect(first.state('s2')).toMatchObject({ status: 'ready', sent: [], dismissed: [] });
    expect(first.markSent('s2', ['d1', 'nope'])).toBe(true);
    expect(first.dismiss('s2', 'd2')).toBe(true);
    expect(first.dismiss('s2', 'nope')).toBe(false);

    // work web restarted: another instance, nothing in its memory.
    const second = createLocalReviews({ prepare: prepared, onChange: () => {}, store });
    const back = second.state('s2');
    expect(back).toMatchObject({ status: 'ready', repo: 'api', sent: ['d1'], dismissed: ['d2'] });
    expect(back.review?.drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(second.files('s2')?.map((f) => f.path)).toEqual([FILE]);
    // A dismissed note can be brought back.
    expect(second.dismiss('s2', 'd2', false)).toBe(true);
    expect(createLocalReviews({ prepare: prepared, onChange: () => {}, store }).state('s2').dismissed).toEqual([]);
  });

  it('preparing again starts over (nothing sent or dismissed); a try that fails keeps the stored one; a drop forgets it', async () => {
    const reviews = createLocalReviews({ prepare: prepared, onChange: () => {}, store });
    reviews.start('s3', session, undefined);
    await flush();
    await flush();
    reviews.markSent('s3', ['d1']);
    reviews.start('s3', session, undefined);
    await flush();
    await flush();
    expect(reviews.state('s3')).toMatchObject({ status: 'ready', sent: [], dismissed: [] });

    reviews.markSent('s3', ['d2']);
    const failing = createLocalReviews({ prepare: async () => Promise.reject(new Error('no')), onChange: () => {}, store });
    failing.start('s3', session, undefined);
    await flush();
    expect(failing.state('s3')).toMatchObject({ status: 'failed', error: 'no', sent: ['d2'] });
    expect(readLocalReview('s3')?.sent).toEqual(['d2']);

    reviews.drop('s3');
    expect(readLocalReview('s3')).toBeNull();
    expect(reviews.state('s3').status).toBe('none');
  });

  it('with no review ready there is nothing to mark', () => {
    const reviews = createLocalReviews({ prepare: prepared, onChange: () => {}, store });
    expect(reviews.markSent('s4', ['d1'])).toBe(false);
    expect(reviews.dismiss('s4', 'd1')).toBe(false);
  });
});
