import fs from 'node:fs';
import path from 'node:path';
import { runGitAsync, runGitSync, writeTempTreeAsync } from '../diff/git-tree-snapshot.js';

/**
 * A worktree's uncommitted work, kept when archiving removes the worktree
 * and put back when the session is restored. Modified, deleted and new
 * (untracked, not git-ignored) files are snapshotted into a commit on top of
 * HEAD, the way checkpoints are (a temp index: the real one is untouched),
 * kept alive by a ref in the repo (`refs/work/archive/<session>/<repo>`,
 * shared by its worktrees, so it outlives this one), and written as a binary
 * patch into the archive folder — the copy Restore applies, readable by hand.
 * Git-ignored files aren't included (build output, local settings that
 * `copyFiles` copies again); staged and unstaged come back alike, unstaged.
 */

/** A bigger patch isn't kept: the worktree stays instead (a stray dump file shouldn't land in ~/.work). */
export const MAX_SAVED_PATCH_BYTES = 50 * 1024 * 1024;

export interface SavedUncommitted {
  /** The snapshot commit (its parent is `base`). */
  commit: string;
  /** HEAD when it was saved. */
  base: string;
  ref: string;
  files: number;
  /** The patch's file name in the archive's `uncommitted/` folder. */
  patch: string;
  /** Put back by a Restore (then not again). */
  restoredAt?: string;
  /** A Restore that couldn't put it back: why (the ref and patch stay). */
  restoreError?: string;
}

export type SaveResult = { clean: true } | { saved: SavedUncommitted } | { error: string };

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
/** Where a save is kept: per session, repo and archive time, so a later archive never overwrites one a Restore couldn't put back. */
export const archiveRefFor = (sessionId: string, repo: string, stamp: number): string => `refs/work/archive/${safeName(sessionId)}/${safeName(repo)}/${stamp}`;
/** Every save of a session lives under this (deleted with the session). */
export const archiveRefsPrefix = (sessionId: string): string => `refs/work/archive/${safeName(sessionId)}/`;
export const uncommittedDir = (archiveDir: string): string => path.join(archiveDir, 'uncommitted');

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'work',
  GIT_AUTHOR_EMAIL: 'work@local',
  GIT_COMMITTER_NAME: 'work',
  GIT_COMMITTER_EMAIL: 'work@local',
};

/** Save `worktree`'s uncommitted work under `ref` and as `<archiveDir>/uncommitted/<patchName>.patch`. */
export async function saveUncommitted(worktree: string, repo: string, ref: string, archiveDir: string, patchName = repo, maxBytes = MAX_SAVED_PATCH_BYTES): Promise<SaveResult> {
  const status = await runGitAsync(worktree, { args: ['status', '--porcelain', '--untracked-files=all'] });
  if (status.status !== 0) return { error: `git can't read ${repo}` };
  const files = status.stdout.split('\n').filter((l) => l.trim()).length;
  if (files === 0) return { clean: true };

  const tree = await writeTempTreeAsync(worktree, { includeWorkingTree: true });
  if (!tree?.headSha) return { error: `git couldn't snapshot ${repo}` };
  const commit = await runGitAsync(worktree, {
    args: ['commit-tree', tree.treeSha, '-p', tree.headSha, '-m', 'work archive: uncommitted changes'],
    env: { ...process.env, ...COMMIT_ENV },
  });
  const sha = commit.stdout.trim();
  if (commit.status !== 0 || !sha) return { error: `git couldn't snapshot ${repo}` };

  const dir = uncommittedDir(archiveDir);
  fs.mkdirSync(dir, { recursive: true });
  const patch = `${safeName(patchName)}.patch`;
  const patchPath = path.join(dir, patch);
  const diff = await runGitAsync(worktree, { args: ['diff', '--binary', '--no-color', '--no-ext-diff', `--output=${patchPath}`, tree.headSha, sha] });
  const size = fs.existsSync(patchPath) ? fs.statSync(patchPath).size : 0;
  if (diff.status !== 0 || size === 0) {
    fs.rmSync(patchPath, { force: true });
    return { error: `git couldn't write ${repo}'s changes as a patch` };
  }
  if (size > maxBytes) {
    fs.rmSync(patchPath, { force: true });
    return { error: `${repo}'s uncommitted changes are too large to keep (${Math.round(size / 1024 / 1024)} MB)` };
  }
  const pinned = await runGitAsync(worktree, { args: ['update-ref', ref, sha] });
  if (pinned.status !== 0) {
    fs.rmSync(patchPath, { force: true });
    return { error: `git couldn't keep ${repo}'s changes (update-ref)` };
  }
  return { saved: { commit: sha, base: tree.headSha, ref, files, patch } };
}

/** Undo a save that wasn't needed after all (the worktree stayed): its ref and patch go. */
export async function dropSaved(repoRoot: string, saved: SavedUncommitted, archiveDir: string): Promise<void> {
  await runGitAsync(repoRoot, { args: ['update-ref', '-d', saved.ref] });
  fs.rmSync(path.join(uncommittedDir(archiveDir), saved.patch), { force: true });
}

/**
 * Put saved work back into a recreated worktree: the patch applied to the
 * working tree (nothing staged). Refuses rather than mixes: when the
 * worktree already has changes of its own, or the patch doesn't apply
 * (the branch moved on) — the ref and the patch stay for doing it by hand.
 * On success the ref goes (the patch stays in the archive).
 */
export async function restoreUncommitted(worktree: string, saved: SavedUncommitted, archiveDir: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const patchPath = path.join(uncommittedDir(archiveDir), saved.patch);
  const byHand = `the changes are kept in ${saved.ref} and ${patchPath}`;
  if (!fs.existsSync(patchPath)) return { ok: false, error: `its saved patch is missing (${patchPath})` };
  const status = await runGitAsync(worktree, { args: ['status', '--porcelain', '--untracked-files=all'] });
  if (status.status !== 0) return { ok: false, error: `git can't read the worktree; ${byHand}` };
  if (status.stdout.trim()) return { ok: false, error: `the worktree already has changes, so they weren't mixed in; ${byHand}` };
  const check = await runGitAsync(worktree, { args: ['apply', '--binary', '--check', patchPath] });
  if (check.status !== 0) return { ok: false, error: `they no longer apply (the branch moved on); ${byHand}` };
  const apply = await runGitAsync(worktree, { args: ['apply', '--binary', patchPath] });
  if (apply.status !== 0) return { ok: false, error: `git apply failed; ${byHand}` };
  await runGitAsync(worktree, { args: ['update-ref', '-d', saved.ref] });
  return { ok: true };
}

/** Delete every saved ref of a session in a repo (the session is deleted; its archive folder goes too). */
export function dropSessionSaves(repoRoot: string, sessionId: string): void {
  const refs = runGitSync(repoRoot, { args: ['for-each-ref', '--format=%(refname)', archiveRefsPrefix(sessionId)] });
  for (const ref of refs.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) runGitSync(repoRoot, { args: ['update-ref', '-d', ref] });
}

/** Shape guard for the archive record's `uncommitted` map (stored JSON). */
export function isSavedUncommitted(x: unknown): x is SavedUncommitted {
  const v = x as SavedUncommitted | null;
  return !!v && typeof v === 'object' && typeof v.commit === 'string' && typeof v.base === 'string' && typeof v.ref === 'string' && typeof v.patch === 'string' && typeof v.files === 'number';
}
