import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchScopeDiffByHash } from '../../src/web/src/api/client.js';

/**
 * The `/diff/<hash>` URL the client builds decides whether the server
 * serves a base diff (Uncommitted / Since branch) or a checkpoint-range
 * diff — the server treats a `from`/`to` range as overriding `base`.
 *
 * ReviewApp relies on this contract: when the checkpoint range is not the
 * active selector it passes `range === undefined`, and that MUST produce a
 * `?base=branch` request so the "Since branch" tab actually shows the
 * branch diff. (Regression: a pinned-but-inactive range used to be sent on
 * every open after the first, silently hijacking the base tabs.)
 */
describe('fetchScopeDiffByHash URL construction', () => {
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        captured.push(path);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ repos: [] }),
        } as Response);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests base=branch when no range is provided', async () => {
    await fetchScopeDiffByHash('abc123', 'branch');
    expect(captured).toEqual(['/api/scopes/abc123/diff?base=branch']);
  });

  it('omits the query for the default uncommitted base', async () => {
    await fetchScopeDiffByHash('abc123', 'uncommitted');
    expect(captured).toEqual(['/api/scopes/abc123/diff']);
  });

  it('sends from/to and drops base when a range is active', async () => {
    await fetchScopeDiffByHash('abc123', 'branch', { from: 0, to: 'working' });
    expect(captured).toEqual(['/api/scopes/abc123/diff?from=0&to=working']);
  });
});
