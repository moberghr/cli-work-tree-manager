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
 * The branch a checkout is working on: the one checked out, or — HEAD detached in the middle of a rebase — the one
 * being rebased (`rebase-merge/head-name`, `rebase-apply/head-name`). Null: detached otherwise, or not a checkout.
 * HEAD files only. The Diff tab's history reads it: a rebase that stops on a conflict isn't a move to another branch.
 */
export function workingBranch(checkout: string): string | null {
  const name = checkedOutBranch(checkout);
  if (name) return name;
  const dirs = gitDirs(checkout);
  if (!dirs) return null;
  for (const folder of ['rebase-merge', 'rebase-apply']) {
    try {
      const b = branchFromHead(`ref: ${fs.readFileSync(path.join(dirs.gitDir, folder, 'head-name'), 'utf8').trim()}`);
      if (b) return b;
    } catch {
      /* no rebase of that kind under way */
    }
  }
  return null;
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

/**
 * The commit a ref names, read from the repo's files (no `git`): `HEAD` (the checkout's own; a branch it names is
 * followed) or `refs/heads/<name>`, loose or in `packed-refs`. Null when the files don't say (a ref git keeps
 * elsewhere, a symbolic chain): ask git then. Cheap enough to key a cache by on every request.
 */
export function refShaFromFiles(checkout: string, ref: 'HEAD' | `refs/heads/${string}`): string | null {
  const dirs = gitDirs(checkout);
  if (!dirs) return null;
  const sha = (s: string) => (/^[0-9a-f]{40,64}$/.test(s) ? s : null);
  let name: string = ref;
  if (ref === 'HEAD') {
    let head: string;
    try {
      head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8').trim();
    } catch {
      return null;
    }
    const m = /^ref:\s*(refs\/heads\/.+)$/.exec(head);
    if (!m) return sha(head);
    name = m[1];
  }
  try {
    return sha(fs.readFileSync(path.join(dirs.commonDir, ...name.split('/')), 'utf8').trim());
  } catch {
    /* not loose: packed */
  }
  try {
    for (const line of fs.readFileSync(path.join(dirs.commonDir, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [s, r] = line.split(' ');
      if (r === name) return sha(s);
    }
  } catch {
    /* no packed-refs */
  }
  return null;
}

/** `ref: refs/heads/fix/x` → `fix/x`; a commit sha (detached) → null. */
export function branchFromHead(head: string): string | null {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
  return m ? m[1] : null;
}
