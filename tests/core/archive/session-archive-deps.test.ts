import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';
import { archiveMergedSession, defaultArchiveDeps } from '../../../src/core/archive/session-archive-deps.js';
import { archiveSession, readArchive, type ArchiveDeps } from '../../../src/core/archive/session-archive.js';
import { midTurn } from '../../../src/server/routes/ci-routes.js';
import { readStatus, recordStatusEvent } from '../../../src/core/status/session-status.js';

const readStatusState = (id: string) => readStatus(id)?.state;
import { saveHistory } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { listReplies, rememberSent, saveDraft } from '../../../src/core/pr/pr-replies.js';
import { getCommentFileStore } from '../../../src/core/comments/comment-file-store.js';
import { readPendingForSession } from '../../../src/core/comments/pending-delivery.js';

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

describe("the PR watch's archive and busy (web-server wires these as they are)", () => {
  const fake = (over: Partial<ArchiveDeps> = {}): ArchiveDeps => ({
    stopClaude: async () => {},
    removable: async () => ({ ok: false, reason: "it is the repo's own checkout" }),
    removeWorktree: async () => true,
    setArchived: async () => true,
    transcripts: () => [],
    waiting: () => ['1 reply to post on review threads'],
    working: () => false,
    kept: () => ({ replyDrafts: [{ threadId: 'PRRT_kwDOx1', url: 'u', reviewer: 'r', draft: 'd' }], notes: [] }),
    ...over,
  });

  it('archives merged work with what waited in it, says what was kept, and tells the dashboard', async () => {
    const s = { ...session([repo]), branch: 'feat/merged-x' };
    saveHistory([s]);
    const changed = vi.fn();
    expect(await archiveMergedSession(sessionIdFor(s), fake(), changed)).toBe('1 reply draft');
    expect(changed).toHaveBeenCalled();
  });

  it('a turn in progress: throws (the watch notes it and tries again); an unknown or archived session: nothing', async () => {
    const s = { ...session([repo]), branch: 'feat/busy' };
    saveHistory([s, { ...s, branch: 'feat/old', archivedAt: '2026-10-01T00:00:00Z' }]);
    await expect(archiveMergedSession(sessionIdFor(s), fake({ working: () => true }))).rejects.toThrow('in the middle of a turn');
    expect(await archiveMergedSession('nope', fake())).toBeUndefined();
    expect(await archiveMergedSession(sessionIdFor({ target: 'api', branch: 'feat/old' }), fake())).toBeUndefined();
  });

  it('busy means mid-turn: working, or at a permission dialog mid-turn — not a finished turn’s question (reviewed)', async () => {
    const id = 'midturn1';
    await recordStatusEvent(id, { kind: 'prompt' });
    expect(midTurn(id)).toBe(true);
    // A permission prompt mid-turn: stopping its Claude now would lose the pending tool call.
    await recordStatusEvent(id, { kind: 'notification', type: 'permission_prompt', message: 'Claude needs your permission', request: { tool: 'Bash', detail: 'git push' } });
    expect(midTurn(id)).toBe(true);
    // A finished turn that asks you something (DECISION NEEDED): the turn is over.
    await recordStatusEvent(id, { kind: 'stop', lastMessage: 'DECISION NEEDED: squash or merge?' });
    expect(readStatusState(id)).toBe('needs_input');
    expect(midTurn(id)).toBe(false);
    await recordStatusEvent(id, { kind: 'stop', lastMessage: 'Done.' });
    expect(midTurn(id)).toBe(false);
    expect(midTurn('never-seen')).toBe(false);
  });

  it('the archive’s own wait sees it the same: a permission dialog mid-turn holds merged work back', async () => {
    const s = { ...session([repo]), branch: 'feat/dialog' };
    saveHistory([s]);
    const sid = sessionIdFor(s);
    await recordStatusEvent(sid, { kind: 'prompt' });
    await recordStatusEvent(sid, { kind: 'notification', type: 'permission_prompt', message: 'Claude needs your permission', request: { tool: 'Bash', detail: 'npm test' } });
    expect(defaultArchiveDeps().working!(sid)).toBe(true);
    await recordStatusEvent(sid, { kind: 'stop', lastMessage: 'Done.' });
    expect(defaultArchiveDeps().working!(sid)).toBe(false);
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
