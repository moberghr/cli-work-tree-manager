import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveRefFor,
  dropSessionSaves,
  restoreUncommitted,
  saveUncommitted,
  type SavedUncommitted,
} from '../../../src/core/archive/archive-uncommitted.js';
import { restoreArchivedUncommitted } from '../../../src/core/archive/archive-restore.js';
import {
  archiveSession,
  readArchive,
  writeArchiveRecord,
  type ArchiveDeps,
  type ArchiveRecord,
} from '../../../src/core/archive/session-archive.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';
import type { WorkConfig } from '../../../src/core/platform/config.js';

/** Uncommitted work survives an archive that removes the worktree, and comes back on Restore (reported: fix/pdf-generation-speed). */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fixture: string;
let tmp: string;
let repo: string;
let wt: string;
let archiveDir: string;

beforeAll(() => {
  // A repo with a commit, built once (§4.7).
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-uc-fixture-'));
  const r = path.join(fixture, 'repo');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t');
  git(r, 'config', 'user.name', 't');
  git(r, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(r, 'keep.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(r, 'gone.txt'), 'delete me\n');
  fs.writeFileSync(path.join(r, '.gitignore'), 'build/\n');
  git(r, 'add', '.');
  git(r, 'commit', '-q', '-m', 'init');
  git(r, 'branch', 'feat/x');
});
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-uc-'));
  repo = path.join(tmp, 'repo');
  fs.cpSync(path.join(fixture, 'repo'), repo, { recursive: true });
  wt = path.join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, 'feat/x');
  archiveDir = path.join(tmp, 'archive', 'sess1');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** Work in progress: a change, a deletion, a new text file, a new binary file, and build output git ignores. */
function makeWork(dir: string) {
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'one\nTWO\nthree\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  fs.writeFileSync(path.join(dir, 'Harness.cs'), 'class Harness {}\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'out.dll'), 'x');
}

describe('saving and putting back uncommitted work (real git)', () => {
  it('a snapshot kept by a ref and a patch; the real index untouched; back after the worktree is removed and recreated', async () => {
    makeWork(wt);
    git(wt, 'add', 'keep.txt'); // one staged, the rest not: both come back (unstaged)
    const before = git(wt, 'status', '--porcelain');
    const ref = archiveRefFor('sess1', 'api', 1);
    const r = await saveUncommitted(wt, 'api', ref, archiveDir, 'api-1');
    expect(r).toMatchObject({ saved: { ref, files: 4, patch: 'api-1.patch' } });
    const saved = (r as { saved: SavedUncommitted }).saved;
    expect(git(repo, 'rev-parse', ref)).toBe(saved.commit);
    expect(git(wt, 'status', '--porcelain')).toBe(before); // nothing in the worktree or its index changed
    expect(fs.readFileSync(path.join(archiveDir, 'uncommitted', 'api-1.patch'), 'utf8')).toContain('Harness.cs');

    // Archive removes the worktree; Restore makes it again on the branch.
    git(repo, 'worktree', 'remove', '--force', wt);
    git(repo, 'worktree', 'add', '-q', wt, 'feat/x');
    expect(await restoreUncommitted(wt, saved, archiveDir)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(wt, 'keep.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
    expect(fs.existsSync(path.join(wt, 'gone.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'Harness.cs'), 'utf8')).toBe('class Harness {}\n');
    expect([...fs.readFileSync(path.join(wt, 'blob.bin'))]).toEqual([0, 1, 2, 255, 0, 7]);
    expect(fs.existsSync(path.join(wt, 'build'))).toBe(false); // git-ignored: not kept
    expect(git(wt, 'diff', '--cached', '--name-only')).toBe(''); // nothing staged
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', ref)).toThrow(); // the ref went once it was back
  });

  it('changes over the size cap aren’t kept: an error (the worktree stays), and no ref or patch left behind', async () => {
    makeWork(wt);
    const ref = archiveRefFor('sess1', 'api', 9);
    const r = await saveUncommitted(wt, 'api', ref, archiveDir, 'api-9', 10); // a 10-byte cap
    expect(r).toMatchObject({ error: expect.stringContaining('too large to keep') });
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', ref)).toThrow();
    expect(fs.existsSync(path.join(archiveDir, 'uncommitted', 'api-9.patch'))).toBe(false);
  });

  it('a clean worktree has nothing to save', async () => {
    expect(await saveUncommitted(wt, 'api', archiveRefFor('sess1', 'api', 1), archiveDir)).toEqual({ clean: true });
  });

  it('never mixes into a worktree with changes of its own, nor applies over a branch that moved on — the ref and patch stay', async () => {
    makeWork(wt);
    const saved = ((await saveUncommitted(wt, 'api', archiveRefFor('sess1', 'api', 2), archiveDir)) as { saved: SavedUncommitted }).saved;
    git(repo, 'worktree', 'remove', '--force', wt);
    git(repo, 'worktree', 'add', '-q', wt, 'feat/x');

    fs.writeFileSync(path.join(wt, 'mine.txt'), 'new work');
    expect(await restoreUncommitted(wt, saved, archiveDir)).toMatchObject({
      ok: false,
      error: expect.stringContaining('already has changes'),
    });
    fs.rmSync(path.join(wt, 'mine.txt'));

    fs.writeFileSync(path.join(wt, 'keep.txt'), 'rewritten\n');
    git(wt, 'commit', '-qam', 'moved on');
    expect(await restoreUncommitted(wt, saved, archiveDir)).toMatchObject({ ok: false, error: expect.stringContaining('no longer apply') });
    expect(git(repo, 'rev-parse', saved.ref)).toBe(saved.commit);
    expect(fs.existsSync(path.join(archiveDir, 'uncommitted', saved.patch))).toBe(true);
  });

  it('deleting the session deletes its saved refs', async () => {
    makeWork(wt);
    await saveUncommitted(wt, 'api', archiveRefFor('sess1', 'api', 3), archiveDir);
    dropSessionSaves(repo, 'sess1');
    expect(git(repo, 'for-each-ref', 'refs/work/archive/')).toBe('');
  });
});

describe('archiveSession with uncommitted work', () => {
  const session = () =>
    ({
      target: 'api',
      branch: 'feat/x',
      isGroup: false,
      paths: [wt],
      createdAt: '2026-09-01T00:00:00Z',
      lastAccessedAt: '2026-09-01T00:00:00Z',
    }) as WorktreeSession;
  const savedOne: SavedUncommitted = { commit: 'c1', base: 'b1', ref: 'refs/work/archive/x/api/1', files: 3, patch: 'api-1.patch' };
  const deps = (over: Partial<ArchiveDeps> = {}): ArchiveDeps => ({
    stopClaude: async () => {},
    removable: vi.fn(async (_s, o) =>
      o?.uncommittedSaved ? { ok: true, reason: 'merged' } : { ok: false, reason: '3 uncommitted files' },
    ),
    removeWorktree: async () => true,
    setArchived: async () => true,
    transcripts: () => [],
    saveUncommitted: vi.fn(async () => ({ saved: { api: savedOne }, error: null })),
    dropSaved: vi.fn(async () => {}),
    archiveRoot: path.join(tmp, 'archive'),
    now: () => 1,
    ...over,
  });

  it('saved: the worktree goes, the record says where the work is, the message says so', async () => {
    const d = deps();
    const out = await archiveSession(session(), d);
    expect(d.removable).toHaveBeenCalledWith(expect.anything(), { uncommittedSaved: true });
    expect(out).toMatchObject({
      ok: true,
      worktreeRemoved: true,
      message: expect.stringContaining('3 uncommitted files saved for Restore'),
    });
    expect(readArchive(sessionIdFor(session()), path.join(tmp, 'archive'))?.uncommitted).toEqual({ api: savedOne });
  });

  it('kept for another reason: the save is dropped (the changes are still there)', async () => {
    const d = deps({ removable: async () => ({ ok: false, reason: '1 commit not in origin/main' }) });
    const out = await archiveSession(session(), d);
    expect(out).toMatchObject({ worktreeRemoved: false, keptBecause: '1 commit not in origin/main' });
    expect(d.dropSaved).toHaveBeenCalledWith(expect.anything(), { api: savedOne }, expect.any(String));
    expect(readArchive(sessionIdFor(session()), path.join(tmp, 'archive'))?.uncommitted).toBeUndefined();
  });

  it('git stopped halfway (a file in use, the folder left with no git): removed, the save kept, the leftover named (reported)', async () => {
    const d = deps({ removeWorktree: async () => false, halfRemoved: () => [wt] });
    const out = await archiveSession(session(), d);
    expect(out).toMatchObject({
      worktreeRemoved: true,
      keptBecause: null,
      message: expect.stringContaining('git stopped at a file in use'),
    });
    expect(d.dropSaved).not.toHaveBeenCalled();
    const rec = readArchive(sessionIdFor(session()), path.join(tmp, 'archive'));
    expect(rec).toMatchObject({ worktreeRemoved: true, leftovers: [wt], uncommitted: { api: savedOne } });
  });

  it('git refused and the worktree is whole: kept, as before', async () => {
    const d = deps({ removeWorktree: async () => false, halfRemoved: () => [] });
    expect(await archiveSession(session(), d)).toMatchObject({ worktreeRemoved: false, keptBecause: 'git refused to remove the worktree' });
    expect(d.dropSaved).toHaveBeenCalled();
  });

  it('a save that fails keeps the worktree, as before, and says why', async () => {
    const d = deps({ saveUncommitted: async () => ({ saved: {}, error: "api's uncommitted changes are too large to keep (80 MB)" }) });
    const out = await archiveSession(session(), d);
    expect(d.removable).toHaveBeenCalledWith(expect.anything(), { uncommittedSaved: false });
    expect(out).toMatchObject({ worktreeRemoved: false, keptBecause: expect.stringContaining('too large to keep') });
  });
});

describe('Restore puts it back once', () => {
  it('applies on the first restore only; a failure is recorded and not retried', async () => {
    makeWork(wt);
    const root = path.join(tmp, 'archive');
    const s = { target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: '', lastAccessedAt: '' } as WorktreeSession;
    const id = sessionIdFor(s);
    const saved = (
      (await saveUncommitted(wt, 'api', archiveRefFor(id, 'api', 1), path.join(root, id), 'api-1')) as { saved: SavedUncommitted }
    ).saved;
    const rec = {
      sessionId: id,
      target: 'api',
      branch: 'feat/x',
      isGroup: false,
      paths: [wt],
      archivedAt: '',
      worktreeRemoved: true,
      keptBecause: null,
      transcripts: [],
      summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [], jiraKey: null },
      uncommitted: { api: saved },
    } as ArchiveRecord;
    fs.mkdirSync(path.join(root, id), { recursive: true });
    writeArchiveRecord(rec, root);
    git(repo, 'worktree', 'remove', '--force', wt);
    git(repo, 'worktree', 'add', '-q', wt, 'feat/x');
    const config = { repos: { api: repo }, groups: {}, worktreesRoot: tmp, copyFiles: [] } as unknown as WorkConfig;

    expect(await restoreArchivedUncommitted(s, config, root)).toEqual({ restored: ['api'], failed: [] });
    expect(readArchive(id, root)?.uncommitted?.api.restoredAt).toBeTruthy();
    fs.writeFileSync(path.join(wt, 'keep.txt'), 'later work\n');
    expect(await restoreArchivedUncommitted(s, config, root)).toEqual({ restored: [], failed: [] }); // never again
    expect(fs.readFileSync(path.join(wt, 'keep.txt'), 'utf8')).toBe('later work\n');
  });
});
