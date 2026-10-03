import { describe, expect, it } from 'vitest';
import { parsePrJson } from '../../../src/core/pr/pr.js';

const gh = (over: Record<string, unknown>) =>
  JSON.stringify([
    {
      number: 7,
      title: 't',
      headRefName: 'feat/x',
      url: 'u',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'REVIEW_REQUIRED',
      author: { login: 'ana' },
      statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
      reviews: [],
      reviewRequests: [],
      ...over,
    },
  ]);

describe('parsePrJson', () => {
  it('a merge conflict is its own fact: green checks stay green', () => {
    const [pr] = parsePrJson(gh({ mergeable: 'CONFLICTING' }), 'api', 'ana');
    expect(pr).toMatchObject({ checksStatus: 'SUCCESS', conflicting: true, isMine: true });
    expect(parsePrJson(gh({}), 'api', 'ana')[0].conflicting).toBe(false);
  });

  it('review requested: only when you are asked by name', () => {
    expect(parsePrJson(gh({ reviewRequests: [{ login: 'Bo' }] }), 'api', 'bo')[0]).toMatchObject({ reviewRequested: true, isMine: false });
    expect(parsePrJson(gh({ reviewRequests: [{ login: 'cy' }, { name: 'core-team' }] }), 'api', 'bo')[0].reviewRequested).toBe(false);
    // Who you are unknown: nothing is asked of you, and nothing is yours.
    expect(parsePrJson(gh({ reviewRequests: [{ login: 'bo' }] }), 'api', '')[0]).toMatchObject({ reviewRequested: false, isMine: false });
  });

  it('failing checks still read as failing', () => {
    expect(parsePrJson(gh({ statusCheckRollup: [{ conclusion: 'FAILURE' }] }), 'api', 'ana')[0].checksStatus).toBe('FAILURE');
  });
});
