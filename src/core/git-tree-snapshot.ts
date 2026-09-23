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

  /** Copy the repo's real index to `tmpIndex` for its stat cache. Returns
   *  false when there's nothing to copy (fresh repo, unreadable path), and
   *  the caller falls back to `read-tree HEAD`. `git rev-parse --git-path`
   *  resolves the linked-worktree case (.git is a file, index lives under
   *  .git/worktrees/<name>/index); its output may be relative to the cwd we
   *  passed, so resolve it against `repoRoot`. */
  const seedFromRealIndex = (): boolean => {
    try {
      const out = spawn.sync('git', ['rev-parse', '--git-path', 'index'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        windowsHide: true,
      }).stdout;
      if (!out) return false;
      const realIndex = path.resolve(repoRoot, out.trim());
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
      // assume-unchanged / skip-worktree bits ride along in the copy, and
      // `add -A` trusts them and never re-reads those files — an edit to a
      // locally-tweaked config would silently vanish from the snapshot. The
      // read-tree index has no such bits, so fall back to it when any exist.
      // `ls-files -v` tags assume-unchanged with a lowercase letter and
      // skip-worktree with S.
      const listed = run(['ls-files', '-v']);
      if (listed.status !== 0) {
        fs.unlinkSync(tmpIndex);
        return false;
      }
      const flagged = (listed.stdout ?? '')
        .split('\n')
        .some((line) => {
          const tag = line.charAt(0);
          return tag === 'S' || (tag >= 'a' && tag <= 'z');
        });
      if (flagged) {
        fs.unlinkSync(tmpIndex);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  try {
    const headSha =
      (
        spawn.sync('git', ['rev-parse', '--verify', 'HEAD'], {
          cwd: repoRoot,
          encoding: 'utf-8',
          windowsHide: true,
        }).stdout ?? ''
      ).trim() || null;

    // The working-tree snapshot only needs a starting point that `add -A`
    // will overwrite, so prefer the warm real index; HEAD's tree is the
    // fallback. A HEAD-only snapshot must read HEAD verbatim.
    const seeded = includeWorkingTree && seedFromRealIndex();
    if (!seeded && headSha) {
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
