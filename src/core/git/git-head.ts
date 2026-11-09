import fs from 'node:fs';
import path from 'node:path';

/**
 * The branch checked out in a checkout, read from its HEAD file — no `git`
 * process, so the session list can ask for every session on every request.
 * A worktree's `.git` is a file (`gitdir: <repo>/.git/worktrees/<name>`)
 * whose HEAD names the branch; a base checkout's `.git` is the folder.
 *
 * null: detached HEAD, not a checkout, or unreadable.
 */
export function checkedOutBranch(checkout: string): string | null {
  try {
    const dirs = gitDirs(checkout);
    return dirs ? branchFromHead(fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * A checkout's git folders, read from disk (no `git`): its own (`gitDir`: HEAD
 * and its reflog `logs/HEAD` — a worktree's `.git/worktrees/<name>`) and the
 * repo's shared one (`commonDir`: branches and their reflogs). Null when it
 * isn't a checkout.
 */
export function gitDirs(checkout: string): { gitDir: string; commonDir: string } | null {
  try {
    const dotGit = path.join(checkout, '.git');
    if (!fs.statSync(dotGit).isFile()) return { gitDir: dotGit, commonDir: dotGit };
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(checkout, m[1]);
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      /* no commondir file: a repo's own .git folder named by a gitdir file (a submodule) */
    }
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

/** `ref: refs/heads/fix/x` → `fix/x`; a commit sha (detached) → null. */
export function branchFromHead(head: string): string | null {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
  return m ? m[1] : null;
}
