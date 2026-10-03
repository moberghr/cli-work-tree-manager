import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface RepoSpec {
  /** Display name (becomes tab label / repo slug). */
  name: string;
  /** Git working tree root for this repo. */
  root: string;
  /** Argument to `git diff` (sha or ref like HEAD). */
  diffArg: string;
}

/** The 12-char scope hash for a set of repo roots. One root for a single
 *  repo, all roots for a group. Sorting makes it order-independent, so the
 *  same directory set always maps to the same scope across processes — this
 *  is the single source of truth shared by `stableDiffPath`,
 *  `scope-manager`, and the comment-delivery bridge in `pending-delivery`. */
export function scopeHashFor(keyPaths: string[]): string {
  const key = keyPaths.slice().sort().join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** Stable per-scope path stem under ~/.work/diffs/. Pass one root for a
 *  single repo, all roots (sorted) for a group. The hash gives each scope
 *  its own stem; callers append `.pid`, `.url`, `.log` as needed. */
export function stableDiffPath(keyPaths: string[]): string {
  const dir = path.join(os.homedir(), '.work', 'diffs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, scopeHashFor(keyPaths));
}
