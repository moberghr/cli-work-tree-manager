import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import spawn from '../platform/spawn.js';

export interface TempTreeResult {
  /** Tree sha written from the temp index. */
  treeSha: string;
  /** HEAD commit sha, or null when the repo has no commits yet. Callers that
   *  build a commit from `treeSha` use this as the parent. */
  headSha: string | null;
}

/**
 * Build a git tree sha for a repo WITHOUT disturbing the real index, using a
 * throwaway `GIT_INDEX_FILE`. Shared by `checkpoint.ts` (which commits the
 * tree and pins it behind a ref) and `diff-pipeline.ts` (which diffs the tree
 * against a checkpoint commit) — both previously hand-rolled this same
 * read-tree / add / write-tree dance.
 *
 *   cp .git/index <tmp>                            (when includeWorkingTree)
 *   GIT_INDEX_FILE=<tmp> git read-tree HEAD        (otherwise / on copy failure)
 *   GIT_INDEX_FILE=<tmp> git add -A                (when includeWorkingTree)
 *   GIT_INDEX_FILE=<tmp> git write-tree            → treeSha
 *
 * Why the copy: an index built by `read-tree` carries no stat cache, so the
 * following `add -A` has to re-hash EVERY file in the worktree — 3.3s on a
 * mid-size repo, paid on every checkpoint and every `to=working` range diff
 * (twice over for a two-repo group). Seeding from the real index inherits its
 * stat cache, so git only hashes what actually changed: same tree sha, ~0.2s.
 * `add -A` overwrites every entry from the worktree, so staged-but-uncommitted
 * state in the copied index can't leak into the tree — the one exception is a
 * force-added ignored file, which stays (it is staged content, so keeping it
 * is the better answer anyway). An index with assume-unchanged/skip-worktree
 * entries is NOT used as a seed (see `seedFromRealIndex`).
 *
 * With `includeWorkingTree` (default), `add -A` promotes every working-tree
 * change including untracked files (honoring `.gitignore`), so the tree is a
 * full snapshot of the working tree. Without it, the tree is HEAD's tree
 * verbatim (the empty tree on a repo with no commits) — used for the
 * "Initial" checkpoint baseline so a diff of Initial→working reproduces the
 * full uncommitted diff instead of hiding pre-existing changes.
 *
 * Returns null on any git failure (caller should skip this repo). The temp
 * index file is always unlinked.
 */
export function writeTempTree(repoRoot: string, opts: { includeWorkingTree?: boolean } = {}): TempTreeResult | null {
  const steps = tempTreeSteps(repoRoot, opts.includeWorkingTree ?? true);
  let next = steps.next();
  while (!next.done) next = steps.next(runGitSync(repoRoot, next.value));
  return next.value;
}

/**
 * writeTempTree without blocking the event loop — for checkpoints, which run
 * on every Claude turn of every session (a synchronous `git add -A` on a big
 * repo froze the server for seconds, once per finishing turn). One snapshot
 * per repo at a time: turns ending together queue rather than run several
 * `add -A` over the same tree at once.
 */
export function writeTempTreeAsync(repoRoot: string, opts: { includeWorkingTree?: boolean } = {}): Promise<TempTreeResult | null> {
  return inRepoQueue(repoRoot, async () => {
    const steps = tempTreeSteps(repoRoot, opts.includeWorkingTree ?? true);
    let next = steps.next();
    while (!next.done) next = steps.next(await runGitAsync(repoRoot, next.value));
    return next.value;
  });
}

/** One git command of the snapshot: its args, and the env it runs with. */
export interface GitStep {
  args: string[];
  env?: NodeJS.ProcessEnv;
}
export interface GitResult {
  status: number | null;
  stdout: string;
}

/**
 * The snapshot's steps, once, for both drivers: yields each git command and
 * gets its result back; returns the tree. (fs work in between — copying the
 * index, removing the temp file — is quick and stays synchronous.)
 */
function* tempTreeSteps(repoRoot: string, includeWorkingTree: boolean): Generator<GitStep, TempTreeResult | null, GitResult> {
  const tmpIndex = path.join(os.tmpdir(), `wd-tree-${process.pid}-${crypto.randomBytes(6).toString('hex')}.idx`);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    const headSha = ((yield { args: ['rev-parse', '--verify', 'HEAD'] }).stdout ?? '').trim() || null;

    // The working-tree snapshot only needs a starting point that `add -A`
    // will overwrite, so prefer the warm real index (its stat cache: git
    // re-hashes only what changed); HEAD's tree is the fallback. A HEAD-only
    // snapshot must read HEAD verbatim.
    let seeded = false;
    if (includeWorkingTree) {
      const out = (yield { args: ['rev-parse', '--git-path', 'index'] }).stdout;
      if (seedIndexCopy(repoRoot, out, tmpIndex)) {
        // assume-unchanged / skip-worktree bits ride along in the copy, and
        // `add -A` trusts them and never re-reads those files — an edit to a
        // locally-tweaked config would silently vanish from the snapshot. The
        // read-tree index has no such bits, so fall back to it when any exist.
        // `ls-files -v` tags assume-unchanged with a lowercase letter and
        // skip-worktree with S.
        const listed = yield { args: ['ls-files', '-v'], env };
        const flagged =
          listed.status !== 0 ||
          (listed.stdout ?? '').split('\n').some((line) => {
            const tag = line.charAt(0);
            return tag === 'S' || (tag >= 'a' && tag <= 'z');
          });
        if (flagged) removeQuietly(tmpIndex);
        else seeded = true;
      }
    }
    if (!seeded && headSha) {
      if ((yield { args: ['read-tree', 'HEAD'], env }).status !== 0) return null;
    }
    if (includeWorkingTree) {
      // `-A` against a temp index seeded from HEAD (or empty) captures the
      // full working-tree state, subject to .gitignore.
      if ((yield { args: ['add', '-A'], env }).status !== 0) return null;
    }
    const wt = yield { args: ['write-tree'], env };
    if (wt.status !== 0 || !wt.stdout) return null;
    return { treeSha: wt.stdout.trim(), headSha };
  } finally {
    removeQuietly(tmpIndex);
  }
}

/** Copy the repo's real index (`git rev-parse --git-path index` output,
 *  relative to the repo root in a linked worktree) to `tmpIndex`, keeping
 *  its mtime. False when there's nothing to copy (fresh repo). */
function seedIndexCopy(repoRoot: string, gitPathOut: string, tmpIndex: string): boolean {
  try {
    if (!gitPathOut) return false;
    const realIndex = path.resolve(repoRoot, gitPathOut.trim());
    if (!fs.existsSync(realIndex)) return false;
    fs.copyFileSync(realIndex, tmpIndex);
    // Carry the real index's mtime over. Git re-hashes "racily clean"
    // entries — file mtime >= the index file's own mtime — rather than
    // trusting their cached stat. A copy stamped "now" would make those
    // entries look safely clean, and a same-size edit landing in the same
    // timestamp tick as an index refresh would be missed. copyFileSync
    // preserves times on Windows (CopyFileW) but not on Linux/macOS.
    const st = fs.statSync(realIndex);
    fs.utimesSync(tmpIndex, st.atime, st.mtime);
    return true;
  } catch {
    return false;
  }
}

function removeQuietly(file: string): void {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // Temp-file leftover isn't fatal — the OS cleans it eventually.
  }
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function runGitSync(cwd: string, step: GitStep): GitResult {
  const r = spawn.sync('git', step.args, {
    cwd,
    encoding: 'utf-8',
    env: step.env ?? process.env,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** A git command off the event loop (argv only, no shell). */
export function runGitAsync(cwd: string, step: GitStep): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let size = 0;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', step.args, { cwd, env: step.env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ status: null, stdout: '' });
      return;
    }
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => {
      size += d.length;
      if (size <= GIT_MAX_BUFFER) stdout += d;
    });
    child.on('error', () => resolve({ status: null, stdout: '' }));
    child.on('close', (code) => resolve({ status: code, stdout }));
  });
}

const repoQueues = new Map<string, Promise<unknown>>();

/** Run `fn` after whatever is queued for this repo; the queue empties itself. */
export function inRepoQueue<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot).toLowerCase();
  const prev = repoQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  repoQueues.set(key, tail);
  void tail.then(() => {
    if (repoQueues.get(key) === tail) repoQueues.delete(key);
  });
  return run;
}
