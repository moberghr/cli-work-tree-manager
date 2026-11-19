import { describe, expect, it, vi } from 'vitest';
import { reviewFocus } from '../../../src/core/review/review-focus.js';
import { prepareLocalReview } from '../../../src/core/review/local-review.js';
import { buildReview } from '../../../src/core/review/review-build.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** What a review is told to pay attention to: for every review, and for a repo (asked for). */
describe('reviewFocus', () => {
  const config = {
    reviews: {
      focus: ['Card data is never logged'],
      focusFor: { api: ['A migration has a way back', 'Card data is never logged'], web: ['Forms are keyboard reachable'] },
    },
  };

  it('the list for every review, then each named repo’s own, each once', () => {
    expect(reviewFocus(config, ['api'])).toEqual(['Card data is never logged', 'A migration has a way back']);
    expect(reviewFocus(config, ['shop', 'api', 'web', 'api'])).toEqual([
      'Card data is never logged',
      'A migration has a way back',
      'Forms are keyboard reachable',
    ]);
    expect(reviewFocus(config, [])).toEqual(['Card data is never logged']);
    expect(reviewFocus({ reviews: {} }, ['api'])).toEqual([]);
    expect(reviewFocus(null, ['api'])).toEqual([]);
  });
});

describe('a review prepared with it', () => {
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
  const diff = () => ({ repos: [{ name: 'x', files }], resolvedBase: 'origin/main' });
  const answer = JSON.stringify({
    stories: [
      { title: 'A class.', why: 'W', risk: 'R', riskLevel: 3, flags: [], files: [FILE], verdict: 'ready', verdictWhy: 'It is two lines.' },
    ],
    notes: [],
  });

  it('a session’s review: the AI step is told, the review says it was, and the story has its verdict', async () => {
    const agent = vi.fn(async (_prompt: string) => answer);
    const p = await prepareLocalReview(session, undefined, { diff, agent, attention: () => ['Card data is never logged'] });
    expect(agent.mock.calls[0][0]).toContain('Pay attention to:\n- Card data is never logged');
    expect(p.review.attention).toEqual(['Card data is never logged']);
    expect(p.review.stories[0]).toMatchObject({ verdict: 'ready', verdictWhy: 'It is two lines.' });
    // Read in its folder too: the same instruction goes there.
    const ask = vi.fn(async (_prompt: string) => answer);
    await prepareLocalReview(session, undefined, {
      diff,
      agent,
      attention: () => ['Card data is never logged'],
      inTree: async () => ({ lines: ['L'], ask }),
    });
    expect(ask.mock.calls[0][0]).toContain('Pay attention to:\n- Card data is never logged');
  });

  it('with nothing asked, or no AI step, the review says nothing of it', async () => {
    const agent = vi.fn(async (_prompt: string) => answer);
    const none = await prepareLocalReview(session, undefined, { diff, agent });
    expect(none.review).not.toHaveProperty('attention');
    expect(agent.mock.calls[0][0]).not.toContain('Pay attention to:');
    const noAgent = await prepareLocalReview(session, undefined, { diff, attention: () => ['x'] });
    expect(noAgent.review).not.toHaveProperty('attention');
    const meta = { repo: 'api', number: 1, title: 'T', url: '', author: 'a', branch: 'b', base: 'main', headSha: 's' };
    expect(buildReview(meta, files, { whitespaceOnly: new Set(), generated: new Set() }, null, { attention: ['x'] })).not.toHaveProperty(
      'attention',
    );
  });
});
