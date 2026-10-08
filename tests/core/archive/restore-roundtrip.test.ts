import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, getCurrentBranch } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { setupWorktree } from '../../../src/core/worktree/worktree.js';
import { findSession, loadHistory } from '../../../src/core/sessions/history.js';
import { archiveSession, readArchive } from '../../../src/core/archive/session-archive.js';
import { defaultArchiveDeps } from '../../../src/core/archive/session-archive-deps.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { loadManifest, takeCheckpoint } from '../../../src/core/diff/checkpoint.js';
import { saveIgnored } from '../../../src/core/archive/archive-ignored.js';
import { scopeHashForPaths } from '../../../src/core/diff/scope-manager.js';

/**
 * Archive, then Restore: the session comes back as if it had never been
 * archived — on its branch, in a worktree at the same place, with its
 * uncommitted and untracked files, its local settings and editor state
 * (git-ignored), and its turns in the Diff tab. Build output doesn't come
 * back (a build makes it again).
 */

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtrip-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);

describe('Restore brings a session back as it was before Archive', () => {
  it('branch, worktree, uncommitted and untracked files, local settings, editor state and turns', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 't@t.t'], repo);
    git(['config', 'user.name', 'T'], repo);
    write(path.join(repo, '.gitignore'), 'bin/\nobj/\n.vs/\nappsettings.Development.json\n');
    write(path.join(repo, 'src', 'App.cs'), 'committed\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
    const config: WorkConfig = { worktreesRoot: path.join(tmp, 'worktrees'), repos: { api: repo }, groups: {}, copyFiles: [] };
    saveConfig(config);

    const made = await setupWorktree('api', 'accounting/missing-payment', config, undefined, undefined, { pull: false });
    const wt = made!.paths[0];
    // A turn of Claude's, as the Stop hook takes it.
    const scope = scopeHashForPaths([wt]);
    await takeCheckpoint(scope, [{ name: 'api', root: wt }]);
    write(path.join(wt, 'src', 'App.cs'), 'changed, not committed\n');
    await takeCheckpoint(scope, [{ name: 'api', root: wt }]);
    write(path.join(wt, 'CreateDoublePaymentCorrection.cs'), 'one-off\n');
    write(path.join(wt, 'appsettings.Development.json'), '{ "local": true }\n');
    write(path.join(wt, '.vs', 'Payfac', 'v18', '.suo'), 'editor state');
    write(path.join(wt, 'bin', 'Debug', 'App.dll'), 'build output');
    const turnsBefore = loadManifest(scope).entries.map((e) => e.id);
    expect(turnsBefore).toHaveLength(2);

    const s = findSession(loadHistory(), 'api', 'accounting/missing-payment')!;
    const real = defaultArchiveDeps();
    const out = await archiveSession(s, {
      ...real,
      stopClaude: async () => {},
      transcripts: () => [],
      // Nothing to lose (its work is saved): the worktree goes, as it would for merged work.
      removable: async () => ({ ok: true, reason: '' }),
    });
    expect(out).toMatchObject({ ok: true, worktreeRemoved: true });
    expect(fs.existsSync(wt)).toBe(false);
    expect(readArchive(sessionIdFor(s))?.ignored?.api).toMatchObject({ files: 2, skipped: 0 }); // the settings and the .suo, not bin/

    const back = await setupWorktree('api', 'accounting/missing-payment', config, undefined, undefined, { pull: false });
    expect(back?.paths).toEqual([wt]);
    expect(getCurrentBranch(wt)).toBe('accounting/missing-payment');
    expect(findSession(loadHistory(), 'api', 'accounting/missing-payment')?.archivedAt).toBeUndefined();
    expect(read(path.join(wt, 'src', 'App.cs'))).toBe('changed, not committed\n');
    expect(read(path.join(wt, 'CreateDoublePaymentCorrection.cs'))).toBe('one-off\n');
    expect(read(path.join(wt, 'appsettings.Development.json'))).toBe('{ "local": true }\n');
    expect(read(path.join(wt, '.vs', 'Payfac', 'v18', '.suo'))).toBe('editor state');
    expect(fs.existsSync(path.join(wt, 'bin'))).toBe(false);
    // Its turns are still there for the Diff tab: the refs and their manifest outlived the archive.
    expect(loadManifest(scope).entries.map((e) => e.id)).toEqual(turnsBefore);
    const refs = git(['for-each-ref', '--format=%(refname)', `refs/wd/${scope}/`], repo)
      .stdout.split('\n')
      .filter(Boolean);
    expect(refs).toHaveLength(turnsBefore.length);
    for (const e of loadManifest(scope).entries) expect(e.repos.api).toBeTruthy();
  });
});

describe('the copy of git-ignored files', () => {
  const repoWith = (files: Record<string, string>) => {
    const repo = path.join(tmp, 'r');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-b', 'main'], repo);
    write(path.join(repo, '.gitignore'), '.vs/\n.venv/\nappsettings.Development.json\n*.local\n');
    for (const [f, text] of Object.entries(files)) write(path.join(repo, f), text);
    return repo;
  };

  it("the smallest first: an editor's index can't use up the budget before the local settings (reviewed)", async () => {
    const repo = repoWith({
      '.vs/index/a.db': 'x'.repeat(600),
      '.vs/index/b.db': 'x'.repeat(600),
      'src/appsettings.Development.json': '{}',
      'src/notes.txt': 'untracked, not ignored: the uncommitted save has it',
    });
    const dest = path.join(tmp, 'dest');
    const r = await saveIgnored(repo, dest, { file: 1000, total: 700, files: 100 });
    expect(r).toMatchObject({ files: 2, skipped: 1 });
    expect(fs.existsSync(path.join(dest, 'src', 'appsettings.Development.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'src', 'notes.txt'))).toBe(false); // git lists src/ too; only ignored folders are walked
  });

  it('environments and package caches stay out; it stops looking after so many files (reviewed: a 100k-file .venv)', async () => {
    const repo = repoWith({ '.venv/lib/site.py': 'x', 'a.local': '1', 'b.local': '2', 'c.local': '3' });
    const dest = path.join(tmp, 'dest');
    const r = await saveIgnored(repo, dest, { file: 1000, total: 1000, files: 2 });
    expect(r).toMatchObject({ files: 2, partial: true });
    expect(fs.existsSync(path.join(dest, '.venv'))).toBe(false);
  });
});

describe('a group whose removal went wrong two ways', () => {
  it('one repo half-removed, the other still a worktree: kept (not "removed"), and the saves are kept too (reviewed)', async () => {
    const be = path.join(tmp, 'grp', 'backend');
    const fe = path.join(tmp, 'grp', 'frontend');
    write(path.join(be, 'left.txt'), 'x'); // no .git: half-removed
    write(path.join(fe, '.git'), 'gitdir: x'); // still a worktree
    const s = { target: 'shop', branch: 'feat/x', isGroup: true, paths: [be, fe], createdAt: '', lastAccessedAt: '' };
    const dropSaved = vi.fn(async () => {});
    const out = await archiveSession(s, {
      stopClaude: async () => {},
      removable: async () => ({ ok: true, reason: '' }),
      removeWorktree: async () => false,
      halfRemoved: () => [be],
      setArchived: async () => true,
      transcripts: () => [],
      saveUncommitted: async () => ({ saved: { backend: { commit: 'c', base: 'b', ref: 'r', files: 1, patch: 'p' } }, error: null }),
      dropSaved,
      archiveRoot: path.join(tmp, 'archive'),
    });
    expect(out).toMatchObject({ worktreeRemoved: false, keptBecause: expect.stringContaining('only in part') });
    expect(dropSaved).not.toHaveBeenCalled();
  });
});
