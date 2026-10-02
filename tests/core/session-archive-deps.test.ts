import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';
import { defaultArchiveDeps } from '../../src/core/session-archive-deps.js';
import { archiveSession, readArchive } from '../../src/core/session-archive.js';
import { saveHistory } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { listReplies, rememberSent, saveDraft } from '../../src/core/pr-replies.js';
import { getCommentFileStore } from '../../src/core/comment-file-store.js';
import { readPendingForSession } from '../../src/core/pending-delivery.js';

// tests/setup gives every file its own HOME, so this config is a throwaway.
let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-deps-repo-'));
  fs.mkdirSync(path.join(os.homedir(), '.work'), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.work', 'config.json'), JSON.stringify({ worktreesRoot: os.tmpdir(), repos: { api: repo }, groups: {}, copyFiles: [] }));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const session = (paths: string[]): WorktreeSession =>
  ({ target: 'api', branch: 'main', isGroup: false, paths, createdAt: '', lastAccessedAt: '' }) as WorktreeSession;

describe('archiving merged work keeps what waited in it (reported: tmp/dispute-email-check)', () => {
  it('reply drafts and undelivered notes stay with the session (Restore shows / delivers them), and the record lists them', async () => {
    const s = { ...session([path.join(repo, '..', 'gone-wt')]), branch: 'tmp/dispute' };
    saveHistory([s]);
    const id = sessionIdFor(s);
    rememberSent(id, [{ threadId: 'PRRT_kwDOabc1', repo: 'api', prNumber: 3515, url: 'https://x/3515#r1', where: null, reviewer: 'copilot', excerpt: 'Opt-out…' }]);
    saveDraft(id, 'PRRT_kwDOabc1', 'Intentional: the store address is the fallback.');
    getCommentFileStore(id).post({ body: 'Rerun the tests' });

    const real = defaultArchiveDeps();
    expect(real.kept!(id)).toMatchObject({ replyDrafts: [{ threadId: 'PRRT_kwDOabc1', draft: 'Intentional: the store address is the fallback.' }], notes: [{ text: 'Rerun the tests' }] });
    const out = await archiveSession(s, { ...real, stopClaude: async () => {}, transcripts: () => [], setArchived: async () => true }, { merged: true });
    expect(out).toMatchObject({ ok: true, kept: '1 reply draft, 1 note for its Claude' });
    // Nothing deleted: the rows are still there for the restored session.
    expect(listReplies(id).filter((r) => r.status === 'draft')).toHaveLength(1);
    expect(readPendingForSession(id).map((c) => c.body)).toEqual(['Rerun the tests']);
    expect(readArchive(id)?.kept?.replyDrafts[0].draft).toBe('Intentional: the store address is the fallback.');
  });
});

describe('defaultArchiveDeps().removable', () => {
  it("never removes the repo's own checkout", async () => {
    expect(await defaultArchiveDeps().removable(session([repo]))).toEqual({ ok: false, reason: "it is the repo's own checkout" });
  });

  it('a worktree that is already gone is fine to "remove"', async () => {
    expect((await defaultArchiveDeps().removable(session([path.join(repo, '..', 'no-such-worktree')]))).ok).toBe(true);
  });
});
