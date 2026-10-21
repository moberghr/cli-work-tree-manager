import fs from 'node:fs';
import { moveStoreComments } from '../comments/comment-file-store.js';
import { atomicWriteFile, ensureFile, withFileLock } from '../platform/fs-safe.js';
import spawn from '../platform/spawn.js';
import type { CheckpointEntry } from './checkpoint.js';
import { manifestPath } from './checkpoint.js';
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
 * Nothing is lost on the way: under both manifests' locks (the ones
 * takeCheckpoint holds), every old ref is first COPIED to the new hash, in
 * one git transaction per repo; only when every repo has its copies is the
 * manifest written under the new hash, and only then are the old refs and
 * the old manifest deleted. Any failure before that undoes the copies and
 * leaves the old scope as it was, said in `problems`. Turns the new scope
 * took meanwhile (a Stop hook that ran while the repo was being added) give
 * way to the old ones: a checkpoint is a whole snapshot, so the session's
 * next turn shows that work as well, against its last old turn.
 *
 * Idempotent, and a no-op when the old scope has nothing.
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
  /** What went wrong, in words; empty when all of it moved. */
  problems: string[];
}

interface Ref {
  name: string;
  sha: string;
}

function gitSync(repo: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawn.sync('git', args, { cwd: repo, encoding: 'utf-8', windowsHide: true, ...(input !== undefined ? { input } : {}) });
  return { ok: r.status === 0, out: (r.stdout ?? '').toString(), err: (r.stderr ?? '').toString().trim() };
}

/** `refs/wd/<hash>/<id>` in one repo, or null when git couldn't list them. */
function scopeRefs(repo: string, hash: string): Ref[] | null {
  const r = gitSync(repo, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/wd/${hash}/`]);
  if (!r.ok) return null;
  return r.out
    .split(/\r?\n/)
    .map((l) => l.trim().split(' '))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([name, sha]) => ({ name, sha }))
    .filter((x) => /^\d+$/.test(x.name.slice(`refs/wd/${hash}/`.length)));
}

const idOf = (hash: string, ref: Ref) => Number(ref.name.slice(`refs/wd/${hash}/`.length));

/** One `git update-ref --stdin` transaction: all of it or none of it. */
function refTransaction(repo: string, lines: string[]): { ok: boolean; err: string } {
  if (lines.length === 0) return { ok: true, err: '' };
  const r = gitSync(repo, ['update-ref', '--stdin'], ['start', ...lines, 'commit', ''].join('\n'));
  return { ok: r.ok, err: r.err };
}

/** A manifest's entries: [] when there is no file; null when there is one that can't be read (never treated as empty). */
function readEntries(hash: string): CheckpointEntry[] | null {
  const file = manifestPath(hash);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; entries?: unknown };
    return parsed.version === 1 && Array.isArray(parsed.entries) ? (parsed.entries as CheckpointEntry[]) : null;
  } catch {
    return null;
  }
}

const empty = JSON.stringify({ version: 1, entries: [] });

export async function migrateScope(oldPaths: string[], newPaths: string[]): Promise<ScopeMigration> {
  const from = scopeHashForPaths(oldPaths);
  const to = scopeHashForPaths(newPaths);
  const out: ScopeMigration = { from, to, manifest: false, refs: 0, comments: 0, problems: [] };
  if (from === to) return out;

  const comments = moveStoreComments(commentStoreIdForScope(from), commentStoreIdForScope(to));
  out.comments = comments.moved;
  if (comments.kept) out.problems.push(`${comments.kept} comment(s) of the old page kept there: the new one has the same id`);

  const oldFile = manifestPath(from);
  if (!fs.existsSync(oldFile)) return out;
  const newFile = manifestPath(to);
  ensureFile(newFile, empty);
  await withFileLock(newFile, () =>
    withFileLock(oldFile, () => {
      moveUnderLocks(oldPaths, newPaths, from, to, out);
    }),
  );
  return out;
}

function moveUnderLocks(oldPaths: string[], newPaths: string[], from: string, to: string, out: ScopeMigration): void {
  const old = readEntries(from);
  const already = readEntries(to);
  if (old === null || already === null) {
    out.problems.push(`the turn list ${old === null ? manifestPath(from) : manifestPath(to)} can't be read: left as it is`);
    return;
  }
  if (old.length === 0) return;
  if (already.length) out.problems.push(`${already.length} turn(s) taken under the new paths meanwhile give way to the old turns`);

  const repos = oldPaths.filter((p) => fs.existsSync(p));
  const newRepos = newPaths.filter((p) => fs.existsSync(p));
  const listed = new Map<string, { old: Ref[]; mine: Ref[] }>();
  for (const repo of new Set([...repos, ...newRepos])) {
    const o = repos.includes(repo) ? scopeRefs(repo, from) : [];
    const m = newRepos.includes(repo) ? scopeRefs(repo, to) : [];
    if (o === null || m === null) {
      out.problems.push(`git couldn't list the turns' snapshots in ${repo}: nothing moved`);
      return;
    }
    listed.set(repo, { old: o, mine: m });
  }

  // 1. In each repo, at once: every old ref copied under the new hash (over one the new scope
  //    took meanwhile), and the new scope's other refs gone. Undone in every repo if one fails.
  const done: Array<{ repo: string; undo: string[] }> = [];
  const undoAll = () => {
    for (const d of done) refTransaction(d.repo, d.undo);
  };
  for (const [repo, { old: o, mine }] of listed) {
    const lines: string[] = [];
    const undo: string[] = [];
    const theirs = new Map(mine.map((r) => [idOf(to, r), r]));
    for (const ref of o) {
      const name = `refs/wd/${to}/${idOf(from, ref)}`;
      const over = theirs.get(idOf(from, ref));
      theirs.delete(idOf(from, ref));
      lines.push(over ? `update ${name} ${ref.sha} ${over.sha}` : `create ${name} ${ref.sha}`);
      undo.push(over ? `update ${name} ${over.sha} ${ref.sha}` : `delete ${name} ${ref.sha}`);
    }
    for (const ref of theirs.values()) {
      lines.push(`delete ${ref.name} ${ref.sha}`);
      undo.push(`create ${ref.name} ${ref.sha}`);
    }
    const r = refTransaction(repo, lines);
    if (!r.ok) {
      undoAll();
      out.problems.push(`couldn't copy the turns' snapshots in ${repo} (${r.err || 'git failed'}): nothing moved`);
      return;
    }
    done.push({ repo, undo });
  }

  // 2. The manifest, under the new hash.
  try {
    atomicWriteFile(manifestPath(to), JSON.stringify({ version: 1, scopeHash: to, entries: old }, null, 2));
  } catch (err) {
    undoAll();
    out.problems.push(`couldn't write the turn list (${(err as Error).message}): nothing moved`);
    return;
  }
  out.manifest = true;

  // 3. Only now the old ones go. What can't be deleted is harmless (a ref nothing lists).
  for (const [repo, { old: o }] of listed) {
    const r = refTransaction(
      repo,
      o.map((ref) => `delete ${ref.name} ${ref.sha}`),
    );
    if (r.ok) out.refs += o.length;
    else out.problems.push(`the old snapshots' refs stay in ${repo} (${r.err || 'git failed'}); the turns are moved`);
  }
  try {
    fs.unlinkSync(manifestPath(from));
  } catch (err) {
    out.problems.push(`the old turn list stays at ${manifestPath(from)} (${(err as Error).message}); the turns are moved`);
  }
}
