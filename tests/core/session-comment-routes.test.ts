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

import { mountSessionCommentRoutes, SUBMIT_DELAY_MS, typeAndSubmit } from '../../src/core/session-comment-routes.js';
import { clearCommentStoreCache } from '../../src/core/comment-file-store.js';
import { formatPendingForPrompt, NOTE_NUDGE, readPendingForSession } from '../../src/core/pending-delivery.js';
import { recordStatusEvent } from '../../src/core/session-status.js';

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
  it('holds drafts, then nudges an idle Claude; the whole review rides on that prompt via the hook', async () => {
    await post('/api/sessions/s1/comments', { repo: 'repo', file: 'a.ts', line: 3, side: 'right', body: 'rename this', status: 'draft' });
    await post('/api/sessions/s1/comments', { repo: 'repo', file: 'b.ts', line: 9, side: 'right', body: 'add a test', status: 'draft' });
    await settle();
    expect(pty.writes).toEqual([]);

    const res = await post('/api/sessions/s1/submit-review', { summary: 'Nearly there' });
    expect(((await res.json()) as { count: number }).count).toBe(2);
    await vi.waitFor(() => expect(pty.writes).toHaveLength(2), { timeout: 2000 });
    // One short line, then Enter (\r; a \n only adds a line to the prompt).
    // Never the note itself: typed in, a long note got mangled into lost
    // "[Pasted text]" placeholders.
    expect(pty.writes).toEqual([NOTE_NUDGE, '\r']);
    // Still pending: the UserPromptSubmit hook claims and attaches them.
    const text = formatPendingForPrompt(readPendingForSession('s1'));
    expect(text).toContain('rename this');
    expect(text).toContain('add a test');
    expect(text).toContain('Nearly there');

    // Submitting again with no drafts types nothing.
    await post('/api/sessions/s1/submit-review', {});
    await new Promise((r) => setTimeout(r, 400));
    expect(pty.writes).toHaveLength(2);
  });
});

describe('a Claude mid-turn', () => {
  it('gets nothing typed: the Stop hook delivers at the end of its turn', async () => {
    await recordStatusEvent('s1', { kind: 'prompt' }); // working
    await post('/api/sessions/s1/comments', { side: 'general', body: 'also check the logs', status: 'published' });
    await new Promise((r) => setTimeout(r, 400));
    expect(pty.writes).toEqual([]);
    expect(readPendingForSession('s1').map((c) => c.body)).toEqual(['also check the logs']);
  });
});

describe('typeAndSubmit', () => {
  it('types the text, waits, then presses Enter (\\r) in a separate write', async () => {
    const writes: string[] = [];
    const waits: number[] = [];
    const ok = await typeAndSubmit('s1', 'line one\nline two', async (_id, d) => (writes.push(d), true), async (ms) => void waits.push(ms));
    expect(ok).toBe(true);
    expect(writes).toEqual(['line one\nline two', '\r']);
    expect(waits).toEqual([SUBMIT_DELAY_MS]);
  });

  it("doesn't press Enter when the text couldn't be written", async () => {
    const writes: string[] = [];
    expect(await typeAndSubmit('s1', 'x', async (_id, d) => (writes.push(d), false), async () => {})).toBe(false);
    expect(writes).toEqual(['x']);
  });
});
