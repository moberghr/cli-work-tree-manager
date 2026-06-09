import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFileLines } from '../../src/web/src/api/client.js';

/**
 * The "expand lines" / "open whole file" features both read file content
 * through `fetchFileLines`. The endpoint it targets differs by mode:
 * scope-mounted (`work web`) goes through `/api/scopes/<hash>/file-lines`,
 * the standalone diff server through the bare `/api/file-lines`. `ref` is
 * only sent when supplied. This locks that URL contract.
 */
describe('fetchFileLines URL construction', () => {
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        captured.push(path);
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ lines: [], start: 1, totalLines: 0, eof: true }),
        } as Response);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the scope endpoint when a hash is given', async () => {
    await fetchFileLines('abc123', 'repo', 'src/a.ts', 5, 24);
    expect(captured[0]).toBe(
      '/api/scopes/abc123/file-lines?repo=repo&path=src%2Fa.ts&start=5&end=24',
    );
  });

  it('hits the standalone endpoint when the hash is undefined', async () => {
    await fetchFileLines(undefined, 'repo', 'a.ts', 1, 10);
    expect(captured[0]).toBe('/api/file-lines?repo=repo&path=a.ts&start=1&end=10');
  });

  it('appends ref only when supplied', async () => {
    await fetchFileLines('h', 'r', 'a.ts', 1, 3, 'HEAD');
    expect(captured[0]).toContain('&ref=HEAD');
  });
});
