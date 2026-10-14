// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCodeFiles } from '../../src/web/src/api/client.js';

afterEach(() => vi.unstubAllGlobals());

describe("a session's file listing, shared by the Code tab and Ctrl+T", () => {
  it('asked once for a while; asked again when the worktree changed (fresh), or after an error', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return new Response(
        JSON.stringify({ group: false, rootFiles: [], repos: [{ name: 'api', files: [`f${n}.ts`], changed: [], truncated: false }] }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const a = await fetchCodeFiles('cache-1');
    const b = await fetchCodeFiles('cache-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    const fresh = await fetchCodeFiles('cache-1', { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh.repos[0].files).toEqual(['f2.ts']);
    expect((await fetchCodeFiles('cache-1')).repos[0].files).toEqual(['f2.ts']); // the fresh one is kept

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(fetchCodeFiles('cache-2')).rejects.toThrow();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCodeFiles('cache-2')).resolves.toBeTruthy(); // a failure isn't kept
  });
});
