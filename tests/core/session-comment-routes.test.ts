import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Batched review: drafts stay put, and submitting sends the whole review
 * to a Claude in our own PTY as ONE message — right away, not on its next
 * turn.
 */

const pty = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('../../src/core/pty-pool.js', () => ({
  peekPty: () => true,
  writeToPty: async (_id: string, text: string) => {
    pty.writes.push(text);
    return true;
  },
}));
vi.mock('../../src/core/web-state.js', () => ({
  findSession: (id: string) => (id === 's1' ? { target: 'repo', branch: 'b', paths: [] } : undefined),
}));

import { mountSessionCommentRoutes } from '../../src/core/session-comment-routes.js';
import { clearCommentStoreCache } from '../../src/core/comment-file-store.js';

let home: string;
let app: Hono;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  clearCommentStoreCache();
  pty.writes.length = 0;
  app = new Hono();
  mountSessionCommentRoutes(app, { broadcast: () => {} });
});
afterEach(() => {
  clearCommentStoreCache();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  app.request(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('submit-review', () => {
  it('holds drafts, then delivers the whole review as one message', async () => {
    await post('/api/sessions/s1/comments', { repo: 'repo', file: 'a.ts', line: 3, side: 'right', body: 'rename this', status: 'draft' });
    await post('/api/sessions/s1/comments', { repo: 'repo', file: 'b.ts', line: 9, side: 'right', body: 'add a test', status: 'draft' });
    await settle();
    expect(pty.writes).toEqual([]);

    const res = await post('/api/sessions/s1/submit-review', { summary: 'Nearly there' });
    expect(((await res.json()) as { count: number }).count).toBe(2);
    await settle();
    expect(pty.writes).toHaveLength(1);
    expect(pty.writes[0]).toContain('rename this');
    expect(pty.writes[0]).toContain('add a test');
    expect(pty.writes[0]).toContain('Nearly there');
    expect(pty.writes[0]).toContain('(3 items)');

    // Delivered once: submitting again with nothing pending sends nothing.
    await post('/api/sessions/s1/submit-review', {});
    await settle();
    expect(pty.writes).toHaveLength(1);
  });
});
