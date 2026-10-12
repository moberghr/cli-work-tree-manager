import { afterEach, describe, expect, it, vi } from 'vitest';
import { scopeHashReviewApi } from '../../src/web/src/api/review-api.js';

afterEach(() => vi.unstubAllGlobals());

describe('scopeHashReviewApi', () => {
  it("asks for the scope's comments with the session's (?linked=1): the browser diff page lists the Diff tab's too", async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ comments: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await scopeHashReviewApi('abc').fetch();
    expect(urls).toEqual(['/api/scopes/abc/comments?linked=1']);
  });
});
