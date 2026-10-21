import fs from 'node:fs';
import { git } from '../git/git.js';
import { tx } from '../platform/db.js';
import { atomicWriteFile } from '../platform/fs-safe.js';
import { loadManifest, manifestPath } from './checkpoint.js';
import { commentStoreIdForScope, scopeHashForPaths } from './scope-manager.js';

/**
 * A session's turn history lives under the scope hash of its paths
 * (`scopeHashForPaths`): the checkpoint manifest
 * (`~/.work/diffs/<hash>.checkpoints.json`), the snapshot refs
 * `refs/wd/<hash>/<id>` in each repo, and the scope's comment store
 * (`scope-<hash>`). When the session's paths change (a repo added to it),
 * all three move to the new hash, or the Diff tab would start over with no
 * turns. Old checkpoints simply lack the new repo: a range reads a repo a
 * checkpoint has no snapshot of as its HEAD (`rangeRefs`).
 *
 * Idempotent, and a no-op when the old scope has nothing. Run it with the
 * old scope released in work web (nothing writing its manifest meanwhile).
 */

export interface ScopeMigration {
  from: string;
  to: string;
  /** The manifest was moved. */
  manifest: boolean;
  /** Refs moved, across the repos. */
  refs: number;
  /** Comments moved to the new store. */
  comments: number;
}

/** `refs/wd/<hash>/*` in one repo: name → object. Empty when git can't list them (no repo there). */
function scopeRefs(repo: string, hash: string): Array<{ name: string; sha: string }> {
  const r = git(['for-each-ref', '--format=%(refname) %(objectname)', `refs/wd/${hash}/`], repo);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(' '))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([name, sha]) => ({ name, sha }));
}

/** Move one repo's refs: each copied to the new hash, then the old one deleted (only once its copy is there). */
function moveRefs(repo: string, from: string, to: string): number {
  let moved = 0;
  for (const ref of scopeRefs(repo, from)) {
    const id = ref.name.slice(`refs/wd/${from}/`.length);
    if (!id || id.includes('/')) continue;
    if (git(['update-ref', `refs/wd/${to}/${id}`, ref.sha], repo).exitCode !== 0) continue;
    git(['update-ref', '-d', ref.name], repo);
    moved++;
  }
  return moved;
}

/** The old manifest under the new hash, unless the new one already has turns of its own (then the old stays put). */
function moveManifest(from: string, to: string): boolean {
  const oldFile = manifestPath(from);
  if (!fs.existsSync(oldFile)) return false;
  const old = loadManifest(from);
  if (loadManifest(to).entries.length > 0) return false;
  atomicWriteFile(manifestPath(to), JSON.stringify({ version: 1, scopeHash: to, entries: old.entries }, null, 2));
  fs.unlinkSync(oldFile);
  return true;
}

/** The scope's comments to the new store, in one transaction (their ids, and so their deliveries, unchanged). */
function moveComments(from: string, to: string): number {
  const oldStore = commentStoreIdForScope(from);
  const newStore = commentStoreIdForScope(to);
  return tx((d) => {
    const n = d.prepare('UPDATE OR IGNORE comments SET store = ? WHERE store = ?').run(newStore, oldStore).changes;
    // One the new store had under the same id already: the new store's stays.
    d.prepare('DELETE FROM comments WHERE store = ?').run(oldStore);
    return n;
  });
}

export function migrateScope(oldPaths: string[], newPaths: string[]): ScopeMigration {
  const from = scopeHashForPaths(oldPaths);
  const to = scopeHashForPaths(newPaths);
  const out: ScopeMigration = { from, to, manifest: false, refs: 0, comments: 0 };
  if (from === to) return out;
  // Refs first: a manifest moved without its refs would name snapshots git may collect.
  for (const repo of oldPaths) if (fs.existsSync(repo)) out.refs += moveRefs(repo, from, to);
  out.manifest = moveManifest(from, to);
  out.comments = moveComments(from, to);
  return out;
}
