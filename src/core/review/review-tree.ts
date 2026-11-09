import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CommandRunner } from '../platform/command-runner.js';
import type { HostResult } from '../hosts/types.js';
import { getConfigDir } from '../platform/config-dir.js';
import { reviewRef } from './review-source.js';

/**
 * A pull request's temporary checkout for the Reviews AI step (#64): a DETACHED worktree at the PR's own head (the
 * private `refs/work/review/<n>` review-source.ts fetched — never a merge commit) under `~/.work/review-trees/`, so
 * the agent reads the codebase as if the PR were checked out: its CLAUDE.md, .claude/rules, callers, interfaces,
 * existing tests. Read only, by the agent's read-only one-shot (`oneShot.readOnly`).
 *
 * Nothing from the PR runs: no install, no build. `git worktree add` runs with an empty hooks folder (a repo whose
 * `core.hooksPath` is a folder of its own — husky's `.husky` — would otherwise run the PR's post-checkout hook) and
 * without symlinks (checked out as small text files: a link can't point the agent's reads elsewhere on disk), and
 * without Git LFS (`NO_LFS`: the PR's `.lfsconfig` could point the download at a server of its choosing — telling it
 * the PR is being reviewed, perhaps asking your credential helper for a login — and a big download outlasts git's
 * timeout). The files the agent reads as settings — hooks, env, permissions, tool servers — are deleted from the copy
 * before it starts (`strip`: the agent's own rule, `oneShot.readOnly.isSettingsFile`); its flags keep them unread too.
 *
 * The tree is always removed afterwards (`withReviewTree`'s finally: `git worktree remove --force`, the folder
 * deleted if that left it, `git worktree prune`); one left by a stopped work web is swept (`sweepReviewTrees`).
 */

/** Where the temporary checkouts go. */
export const reviewTreesDir = (): string => path.join(getConfigDir(), 'review-trees');

/** An empty folder git is pointed at as its hooks folder while it checks the PR out (never one of the repo's). */
const NO_HOOKS = '.no-hooks';

/** git's LFS filter off for the checkout: pointer files stay pointers, nothing is downloaded (`NO_LFS_ENV` too). */
export const NO_LFS = ['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false'];
export const NO_LFS_ENV = { GIT_LFS_SKIP_SMUDGE: '1' };

/** How a checkout is made: where (default `reviewTreesDir()`), and which of its files go before the agent reads it. */
export interface ReviewTreeOpts {
  root?: string;
  /** A file the agent would read as its settings (the agent's own rule): deleted from the copy. */
  strip: (relPath: string) => boolean;
  /** The run's part of the folder's name (default `runSuffix()`, fresh each time; tests fix it). */
  run?: string;
}

/**
 * `<alias>-<n>-<short sha>-<run>`, only characters a folder name takes everywhere. Pure. `run` is this run's own
 * (`runSuffix`): two work webs reviewing the same head (the dev server's click beside the main one) each get their
 * own folder, never deleting the other's checkout. A stopped run's folder is found by the sweep (by age).
 */
export function reviewTreeName(alias: string, number: number, headSha: string, run: string): string {
  const safe = alias.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'repo';
  const tag = run.replace(/[^A-Za-z0-9]/g, '');
  return `${safe}-${number}-${headSha.slice(0, 8)}${tag ? `-${tag}` : ''}`;
}

/** A run's own part of its folder's name: this process and a random part. */
export const runSuffix = (): string => `${process.pid.toString(36)}${randomBytes(3).toString('hex')}`;

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

/** Delete a folder, retrying a file still held for a moment (Windows, an agent just killed). */
function rmTree(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* said by the check below */
  }
  return !fs.existsSync(dir);
}

export interface ReviewTreeAt {
  repoPath: string;
  alias: string;
  number: number;
  /** The PR's head as fetched (its review ref's commit). */
  headSha: string;
}

/** Check the PR out at its review ref into a fresh detached worktree, its settings files deleted. */
export async function createReviewTree(
  run: CommandRunner,
  at: ReviewTreeAt,
  opts: ReviewTreeOpts,
): Promise<HostResult<{ dir: string; removed: string[] }>> {
  const root = opts.root ?? reviewTreesDir();
  const dir = path.join(root, reviewTreeName(at.alias, at.number, at.headSha, opts.run ?? runSuffix()));
  const noHooks = path.join(root, NO_HOOKS);
  fs.mkdirSync(noHooks, { recursive: true });
  // One left here under this very name (a fixed `run`): gone first, so `worktree add` gets an empty folder.
  if (fs.existsSync(dir)) await removeReviewTree(run, at.repoPath, dir);
  const added = await run(
    'git',
    [
      '-c',
      `core.hooksPath=${noHooks}`,
      '-c',
      'core.symlinks=false',
      ...NO_LFS,
      'worktree',
      'add',
      '--detach',
      '--quiet',
      dir,
      reviewRef(at.number),
    ],
    at.repoPath,
    NO_LFS_ENV,
  );
  if (added.code !== 0) {
    await removeReviewTree(run, at.repoPath, dir);
    return { ok: false, error: `couldn't check the PR out: ${firstLine(added.stderr) || 'git worktree add failed'}` };
  }
  // Its head must be the commit the review is of (the ref may have moved since: a sweep fetched a push).
  const head = await run('git', ['rev-parse', 'HEAD'], dir);
  if (head.code !== 0 || head.stdout.trim() !== at.headSha) {
    await removeReviewTree(run, at.repoPath, dir);
    return { ok: false, error: "the checkout isn't at the reviewed commit (the PR moved meanwhile)" };
  }
  const listed = await run('git', ['ls-files', '-z'], dir);
  if (listed.code !== 0) {
    await removeReviewTree(run, at.repoPath, dir);
    return { ok: false, error: "couldn't list the checkout's files to remove its settings" };
  }
  const removed: string[] = [];
  for (const rel of listed.stdout.split('\0').filter((rel) => opts.strip(rel))) {
    const file = path.join(dir, rel);
    fs.rmSync(file, { recursive: true, force: true });
    if (fs.existsSync(file)) {
      await removeReviewTree(run, at.repoPath, dir);
      return { ok: false, error: `couldn't remove ${rel} from the checkout` };
    }
    removed.push(rel);
  }
  return { ok: true, dir, removed };
}

/** Remove a temporary checkout: git's way, then the folder if anything is left, then git forgets it. True when gone. */
export async function removeReviewTree(run: CommandRunner, repoPath: string, dir: string): Promise<boolean> {
  if (fs.existsSync(dir)) await run('git', ['worktree', 'remove', '--force', '--force', dir], repoPath);
  const gone = rmTree(dir);
  await run('git', ['worktree', 'prune'], repoPath);
  return gone;
}

/**
 * Check the PR out, hand the folder to `use`, and remove it whatever happens — `use` failing or throwing included
 * (a timed-out agent is killed, its tree with it, before `use` returns: runInternalReadOnly). `left`: the folder
 * couldn't be removed (the next sweep tries again).
 */
export async function withReviewTree<T>(
  run: CommandRunner,
  at: ReviewTreeAt,
  use: (dir: string, removed: string[]) => Promise<T>,
  opts: ReviewTreeOpts,
): Promise<HostResult<{ value: T; left?: string }>> {
  const tree = await createReviewTree(run, at, opts);
  if (!tree.ok) return tree;
  let value: T;
  let gone: boolean;
  try {
    value = await use(tree.dir, tree.removed);
  } finally {
    // Runs on a throw as well; a folder that won't go is said by `left` (on a throw, the next sweep takes it).
    gone = await removeReviewTree(run, at.repoPath, tree.dir).catch(() => false);
  }
  return { ok: true, value, ...(gone ? {} : { left: tree.dir }) };
}

/** The repository a worktree belongs to, from its `.git` file (`gitdir: <repo git dir>/worktrees/<name>`); null if none. */
function gitDirOf(dir: string): string | null {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'));
    return m ? path.resolve(dir, m[1].trim(), '..', '..') : null;
  } catch {
    return null;
  }
}

/**
 * Remove the temporary checkouts a stopped run left (work web stopped, killed mid-review). One younger than
 * `olderThanMs` is left alone: another work web (the dev server's click) may be reading it now. Each through its
 * repository when its `.git` file names one (git forgets it), else the folder alone. The names swept, and those
 * that wouldn't go.
 */
export async function sweepReviewTrees(
  run: CommandRunner,
  opts: { root?: string; olderThanMs?: number; now?: () => number } = {},
): Promise<{ swept: string[]; failed: string[] }> {
  const root = opts.root ?? reviewTreesDir();
  const now = opts.now?.() ?? Date.now();
  const swept: string[] = [];
  const failed: string[] = [];
  let names: string[];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== NO_HOOKS)
      .map((e) => e.name);
  } catch {
    return { swept, failed }; // no folder yet: nothing left
  }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (opts.olderThanMs && now - fs.statSync(dir).mtimeMs < opts.olderThanMs) continue;
    } catch {
      continue;
    }
    const gitDir = gitDirOf(dir);
    const gone = gitDir && fs.existsSync(gitDir) ? await removeReviewTree(run, gitDir, dir) : rmTree(dir);
    (gone ? swept : failed).push(name);
  }
  return { swept, failed };
}
