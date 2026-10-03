import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeWorktree } from '../../src/web/src/api/panes.js';

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );

describe('removeWorktree', () => {
  it('already gone (deleted a moment ago elsewhere) counts as deleted', async () => {
    answer(404, { error: 'unknown session' });
    expect(await removeWorktree('s1')).toEqual({ ok: true, worktreeRemoved: false, alreadyGone: true });
  });

  it('a refusal is still an error, with the server’s reason', async () => {
    answer(409, { error: 'Not deleted: its Claude is working.', blocked: ['its Claude is working'] });
    await expect(removeWorktree('s1')).rejects.toThrow('its Claude is working');
  });
});
