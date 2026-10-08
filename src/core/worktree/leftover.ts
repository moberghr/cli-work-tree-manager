import fs from 'node:fs';
import path from 'node:path';
import { BUILD_DIR_NAMES } from '../cleanup/build-folders.js';

/**
 * A worktree folder git removed only in part. `git worktree remove` deletes
 * the files, then stops at one that's in use (Visual Studio holds its
 * solution's), having already dropped the `.git` link and the worktree's
 * registration: what's left is a plain folder where the worktree was. It
 * isn't a checkout any more (no branch, no git), and `git worktree add`
 * won't go into it. Making the worktree again sets it aside, adds the
 * worktree, and copies the files back.
 */

/** A worktree's folder that is one: it has its `.git` (a worktree's is a file). */
export function isWorktreeFolder(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** It's there, but git's link is gone: what a removal that stopped halfway leaves. */
export function isLeftover(dir: string): boolean {
  return fs.existsSync(dir) && !isWorktreeFolder(dir);
}

/** Leftovers set aside by this process, by the worktree path they were at: put back after the worktree is made. */
const setAside = new Map<string, string>();

/**
 * Move a leftover folder out of the worktree's way, beside it
 * (`<folder>.leftover-<time>`). Throws, saying why, when it can't — a file
 * in it is still in use.
 */
export function setLeftoverAside(dir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const aside = `${dir}.leftover-${stamp}`;
  try {
    fs.renameSync(dir, aside);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        ? `${dir} is what's left of its worktree, and a file in it is in use (Visual Studio, an editor, a terminal?): close it and try again`
        : `couldn't move what's left of its worktree out of the way (${dir}): ${(err as Error).message}`,
      { cause: err },
    );
  }
  setAside.set(path.resolve(dir), aside);
  return aside;
}

/** The leftover set aside for this worktree path, if any (taken: asked once). */
export function takeLeftover(dir: string): string | null {
  const key = path.resolve(dir);
  const aside = setAside.get(key) ?? null;
  setAside.delete(key);
  return aside;
}

/**
 * Copy a set-aside leftover's files into the new worktree: over what's
 * there (`overwrite`, when nothing else brought its changes back), or only
 * where there's nothing (the archive's save came first and wins). Build
 * output stays behind; a build makes it again. The leftover goes once every
 * file is copied, and stays (said where) otherwise.
 */
export function putLeftoverBack(
  aside: string,
  worktree: string,
  opts: { overwrite: boolean },
): { copied: number; failed: string[]; removed: boolean } {
  let copied = 0;
  const failed: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(aside, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || BUILD_DIR_NAMES.has(e.name)) continue;
        walk(r);
      } else if (e.isFile()) {
        const to = path.join(worktree, r);
        if (!opts.overwrite && fs.existsSync(to)) continue;
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(aside, r), to);
          copied++;
        } catch {
          failed.push(r);
        }
      }
    }
  };
  walk('');
  let removed = false;
  if (!failed.length) {
    try {
      fs.rmSync(aside, { recursive: true, force: true });
      removed = !fs.existsSync(aside);
    } catch {
      /* still in use: it stays, and the caller says where */
    }
  }
  return { copied, failed, removed };
}
