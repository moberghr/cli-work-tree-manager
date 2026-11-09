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
vi.mock('../../../src/core/pty/pty-pool.js', () => ({
  peekPty: () => true,
  writeToPty: async (_id: string, text: string) => {
    pty.writes.push(text);
    return true;
  },
}));
vi.mock('../../../src/core/sessions/web-state.js', () => ({
  findSession: (id: string) =>
    id === 's1'
      ? { target: 'repo', branch: 'b', paths: [] }
      : id === 's2'
        ? { target: 'repo', branch: 'c', paths: [`${process.cwd()}/wt-c`] }
        : undefined,
}));

import { mountSessionCommentRoutes, SUBMIT_DELAY_MS, typeAndSubmit } from '../../../src/server/routes/session-comment-routes.js';
import { clearCommentStoreCache } from '../../../src/core/comments/comment-file-store.js';
import { formatPendingForPrompt, NOTE_NUDGE, readPendingForSession } from '../../../src/core/comments/pending-delivery.js';
import { recordStatusEvent } from '../../../src/core/status/session-status.js';
import { getCommentFileStore } from '../../../src/core/comments/comment-file-store.js';
import { scopeStoreIdsForPaths } from '../../../src/core/comments/pending-delivery.js';

let home: string;
let app: Hono;
const scopeNotes: { hash: string; data: Record<string, unknown> }[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  clearCommentStoreCache();
  pty.writes.length = 0;
  app = new Hono();
  scopeNotes.length = 0;
  mountSessionCommentRoutes(app, { broadcast: () => {}, notifyScope: (data) => void scopeNotes.push({ hash: data.scopeHash, data }) });
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

describe('what the route did with a note (`delivery`, which `work send` reports)', () => {
  it('typed into an idle host Claude; nothing for a draft or a Claude’s own reply', async () => {
    const res = await post('/api/sessions/s1/comments', { side: 'general', body: 'run the tests', status: 'published' });
    expect(((await res.json()) as { delivery: string | null }).delivery).toBe('typed');
    await vi.waitFor(() => expect(pty.writes).toEqual([NOTE_NUDGE, '\r']), { timeout: 2000 });
    const draft = await post('/api/sessions/s1/comments', { side: 'general', body: 'later', status: 'draft' });
    expect(((await draft.json()) as { delivery: string | null }).delivery).toBeNull();
    const own = await post('/api/sessions/s1/comments', { side: 'general', body: 'done', status: 'published', author: 'claude' });
    expect(((await own.json()) as { delivery: string | null }).delivery).toBeNull();
  });
});

describe('a Claude mid-turn', () => {
  it('gets nothing typed: the Stop hook delivers at the end of its turn', async () => {
    await recordStatusEvent('s1', { kind: 'prompt' }); // working
    const res = await post('/api/sessions/s1/comments', { side: 'general', body: 'also check the logs', status: 'published' });
    expect(((await res.json()) as { delivery: string | null }).delivery).toBe('next-turn');
    await new Promise((r) => setTimeout(r, 400));
    expect(pty.writes).toEqual([]);
    expect(readPendingForSession('s1').map((c) => c.body)).toEqual(['also check the logs']);
  });
});

describe('typeAndSubmit', () => {
  it('types the text, waits, then presses Enter (\\r) in a separate write', async () => {
    const writes: string[] = [];
    const waits: number[] = [];
    const ok = await typeAndSubmit(
      's1',
      'line one\nline two',
      async (_id, d) => (writes.push(d), true),
      async (ms) => void waits.push(ms),
    );
    expect(ok).toBe(true);
    expect(writes).toEqual(['line one\nline two', '\r']);
    expect(waits).toEqual([SUBMIT_DELAY_MS]);
  });

  it("doesn't press Enter when the text couldn't be written", async () => {
    const writes: string[] = [];
    expect(
      await typeAndSubmit(
        's1',
        'x',
        async (_id, d) => (writes.push(d), false),
        async () => {},
      ),
    ).toBe(false);
    expect(writes).toEqual(['x']);
  });
});

describe("the browser diff page's comments on the Diff tab (one worktree, two stores)", () => {
  type Listed = { comments: { id: string; body: string; status: string; resolved?: boolean }[] };
  // The scope `wd` registers for s2's worktree: the browser page (`/diff/<hash>`) posts there.
  const scopeStore = () => getCommentFileStore(scopeStoreIdsForPaths([`${process.cwd()}/wt-c`])[0]);
  const scopeHash = () => scopeStoreIdsForPaths([`${process.cwd()}/wt-c`])[0].slice('scope-'.length);
  const list = async () => ((await (await app.request('/api/sessions/s2/comments')).json()) as Listed).comments;

  it("lists them beside the session's own, but not the page's unsent drafts", async () => {
    const onPage = scopeStore().post({ side: 'general', body: 'from the page' });
    scopeStore().post({ side: 'general', body: 'page draft', status: 'draft' });
    await post('/api/sessions/s2/comments', { side: 'general', body: 'from the tab', status: 'published', author: 'claude' });
    expect((await list()).map((c) => c.body)).toEqual(['from the page', 'from the tab']);
    expect((await list())[0].id).toBe(onPage.id);
  });

  it('resolves, answers and deletes one where it is kept, and tells the page', async () => {
    const onPage = scopeStore().post({ side: 'general', body: 'from the page' });

    let res = await post(`/api/sessions/s2/comments/${onPage.id}/resolve`, { resolved: true });
    expect(((await res.json()) as Listed).comments[0].resolved).toBe(true);
    expect(scopeStore().snapshot()[0].resolved).toBe(true);
    expect(scopeNotes.map((n) => n.hash)).toEqual([scopeHash()]);

    // A reply joins its thread in the page's store, sent (a draft there would show on neither view).
    res = await post('/api/sessions/s2/comments', { parentId: onPage.id, body: 'on it', status: 'draft', author: 'claude' });
    expect(res.status).toBe(200);
    expect(
      scopeStore()
        .snapshot()
        .map((c) => [c.body, c.status]),
    ).toEqual([
      ['from the page', 'published'],
      ['on it', 'published'],
    ]);
    expect(getCommentFileStore('s2').snapshot()).toEqual([]);

    res = await app.request(`/api/sessions/s2/comments/${onPage.id}`, { method: 'DELETE' });
    expect(((await res.json()) as Listed).comments.map((c) => c.body)).toEqual(['on it']);
    expect(
      scopeStore()
        .snapshot()
        .map((c) => c.body),
    ).toEqual(['on it']);
  });

  it('a reply on the tab to a thread from the page is typed into an idle Claude, like any note', async () => {
    const onPage = scopeStore().post({ side: 'general', body: 'from the page' });
    const res = await post('/api/sessions/s2/comments', { parentId: onPage.id, body: 'and this too', status: 'published' });
    expect(((await res.json()) as { delivery: string | null }).delivery).toBe('typed');
    await vi.waitFor(() => expect(pty.writes).toEqual([NOTE_NUDGE, '\r']), { timeout: 2000 });
  });

  it("tells the page when the tab's own comments change", async () => {
    await post('/api/sessions/s2/comments', { side: 'general', body: 'mine', status: 'published', author: 'claude' });
    expect(scopeNotes).toEqual([{ hash: scopeHash(), data: expect.objectContaining({ scopeHash: scopeHash() }) }]);
    expect(
      getCommentFileStore('s2')
        .snapshot()
        .map((c) => c.body),
    ).toEqual(['mine']);
  });
});

describe("noteThroughComments (work web's way to tell a session's Claude)", () => {
  it('posts a published general comment through the real route, and throws when the route refuses', async () => {
    const { noteThroughComments } = await import('../../../src/server/session-note.js');
    const note = noteThroughComments(app);
    await note('s1', 'Added repo web to this session.');
    const posted = getCommentFileStore('s1').list();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ side: 'general', status: 'published', body: 'Added repo web to this session.' });
    await expect(note('nope', 'x')).rejects.toThrow(/posting the note failed: 4\d\d/);
  });
});
