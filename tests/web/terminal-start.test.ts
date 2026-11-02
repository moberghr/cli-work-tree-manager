import { describe, expect, it } from 'vitest';
import { START_RETRY_SECONDS, startFailure, startRetryDelay } from '../../src/web/src/state/terminal-start.js';

describe('a failed terminal start (terminal-start.ts)', () => {
  it('tries again after 3, 10, 30 and 60 s, then waits for a click', () => {
    expect(START_RETRY_SECONDS.map((_, i) => startRetryDelay(i))).toEqual([3000, 10_000, 30_000, 60_000]);
    expect(startRetryDelay(4)).toBeNull();
    expect(startRetryDelay(-1)).toBeNull();
  });

  it("says the server's reason, else that the connection closed", () => {
    expect(startFailure('PTY host not answering')).toBe('PTY host not answering');
    expect(startFailure(null)).toBe('the connection closed before it started');
    expect(startFailure('  ')).toBe('the connection closed before it started');
  });
});
