import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import spawn from 'cross-spawn';

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
 *   GIT_INDEX_FILE=<tmp> git read-tree HEAD        (when HEAD exists)
 *   GIT_INDEX_FILE=<tmp> git add -A                (when includeWorkingTree)
 *   GIT_INDEX_FILE=<tmp> git write-tree            → treeSha
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
export function writeTempTree(
  repoRoot: string,
  opts: { includeWorkingTree?: boolean } = {},
): TempTreeResult | null {
  const includeWorkingTree = opts.includeWorkingTree ?? true;
  const tmpIndex = path.join(
    os.tmpdir(),
    `wd-tree-${process.pid}-${crypto.randomBytes(6).toString('hex')}.idx`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const run = (args: string[]) =>
    spawn.sync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      env,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });

  try {
    const headSha =
      (
        spawn.sync('git', ['rev-parse', '--verify', 'HEAD'], {
          cwd: repoRoot,
          encoding: 'utf-8',
          windowsHide: true,
        }).stdout ?? ''
      ).trim() || null;

    if (headSha) {
      const r = run(['read-tree', 'HEAD']);
      if (r.status !== 0) return null;
    }

    if (includeWorkingTree) {
      // `-A` against a temp index seeded from HEAD (or empty) captures the
      // full working-tree state, subject to .gitignore.
      const add = run(['add', '-A']);
      if (add.status !== 0) return null;
    }

    const wt = run(['write-tree']);
    if (wt.status !== 0 || !wt.stdout) return null;
    return { treeSha: wt.stdout.trim(), headSha };
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
    } catch {
      // Temp-file leftover isn't fatal — the OS cleans it eventually.
    }
  }
}
