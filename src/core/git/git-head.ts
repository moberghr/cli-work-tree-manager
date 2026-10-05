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
    const dotGit = path.join(checkout, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(checkout, m[1]);
    }
    return branchFromHead(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'));
  } catch {
    return null;
  }
}

/** `ref: refs/heads/fix/x` → `fix/x`; a commit sha (detached) → null. */
export function branchFromHead(head: string): string | null {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
  return m ? m[1] : null;
}
