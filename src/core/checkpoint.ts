/**
 * Per-scope diff checkpoints.
 *
 * A "checkpoint" is a snapshot of every repo in a scope's working tree
 * (including untracked files) captured as a real git commit and held alive
 * by `refs/wd/<scope-hash>/<n>` in each repo. A small JSON manifest at
 * `~/.work/diffs/<scope-hash>.checkpoints.json` records the per-checkpoint
 * timestamp + repo→sha mapping so the SPA can list checkpoints and ask for
 * a diff between any two (or between one and the live working tree).
 *
 * Snapshots are taken automatically:
 *   - once when a scope is first registered (the "Initial" point)
 *   - again whenever the scope's fs-watch debounce fires AND the working
 *     tree differs from the previous snapshot (the dedup keeps idle saves
 *     from spawning empty checkpoints)
 *
 * The capture mechanism uses a temp git index file so the real index is
 * never disturbed:
 *
 *     GIT_INDEX_FILE=<tmp> git read-tree HEAD
 *     GIT_INDEX_FILE=<tmp> git add -A
 *     GIT_INDEX_FILE=<tmp> git write-tree   →  <tree-sha>
 *     git commit-tree <tree-sha> -p HEAD -m "wd checkpoint"  →  <commit-sha>
 *     git update-ref refs/wd/<hash>/<n> <commit-sha>
 *
 * Untracked files end up in the snapshot because `git add -A` against the
 * temp index promotes them. `.gitignore` is honoured (same as the diff
 * pipeline's untracked detection).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import spawn from 'cross-spawn';
import { atomicWriteFile, ensureFile, withFileLock } from './fs-safe.js';

export interface CheckpointEntry {
  /** Monotonic per-scope sequence id, starting at 0 for the initial
   *  snapshot. */
  id: number;
  /** ISO timestamp of capture. */
  ts: string;
  /** Human label — "Initial" for id 0, otherwise empty (the SPA shows
   *  "#1", "#2", ...). Reserved for future user-labelled checkpoints. */
  label?: string;
  /** Per-repo commit sha captured. Keyed by repo name (the same `name`
   *  used in `RepoData`). When a repo has no head yet (fresh repo, no
   *  commits), the value is null — diff ranges that touch it on the
   *  "from" side fall back to the empty tree. */
  repos: Record<string, string | null>;
}

export interface CheckpointManifest {
  version: 1;
  scopeHash: string;
  entries: CheckpointEntry[];
}

/** Where this scope's manifest lives on disk. */
export function manifestPath(scopeHash: string): string {
  const dir = path.join(os.homedir(), '.work', 'diffs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${scopeHash}.checkpoints.json`);
}

function emptyManifest(scopeHash: string): CheckpointManifest {
  return { version: 1, scopeHash, entries: [] };
}

/** Read manifest from disk (returns an empty one if the file is missing
 *  or unparseable). Never throws. */
export function loadManifest(scopeHash: string): CheckpointManifest {
  const file = manifestPath(scopeHash);
  if (!fs.existsSync(file)) return emptyManifest(scopeHash);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CheckpointManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return emptyManifest(scopeHash);
    }
    return {
      version: 1,
      scopeHash,
      entries: parsed.entries as CheckpointEntry[],
    };
  } catch {
    return emptyManifest(scopeHash);
  }
}

// (Previously a separate `appendCheckpoint` lived here. It was folded
// into `takeCheckpoint` so id assignment + snapshot + ref write + manifest
// append all happen under a single lock — concurrent fs-watch fires across
// the same scope must not race on `nextId`.)

/**
 * Capture the working tree (incl. untracked, respecting .gitignore) of a
 * single repo as a commit and return its sha. Updates
 * `refs/wd/<scopeHash>/<id>` to point at the commit so git GC can't
 * reclaim it. Returns null on failure (caller should skip this repo).
 *
 * Internally uses a temp `GIT_INDEX_FILE` so the user's real index is
 * untouched. The temp file is unlinked on success and on most failures.
 */
export function snapshotRepo(
  repoRoot: string,
  scopeHash: string,
  id: number,
): string | null {
  const tmpIndex = path.join(
    os.tmpdir(),
    `wd-cp-${process.pid}-${crypto.randomBytes(6).toString('hex')}.idx`,
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
    // Detect whether HEAD exists. Fresh repos with no commits can still
    // be snapshotted — we just skip the read-tree + parent below.
    const headSha = (
      spawn.sync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        windowsHide: true,
      }).stdout ?? ''
    ).trim();
    const hasHead = headSha.length > 0;

    if (hasHead) {
      const r = run(['read-tree', 'HEAD']);
      if (r.status !== 0) return null;
    }

    // Stage every working-tree change INCLUDING untracked. `-A` against
    // a temp index that was either empty or seeded from HEAD captures
    // the full working-tree state (subject to .gitignore).
    const add = run(['add', '-A']);
    if (add.status !== 0) return null;

    const wt = run(['write-tree']);
    if (wt.status !== 0 || !wt.stdout) return null;
    const treeSha = wt.stdout.trim();

    // commit-tree doesn't need the temp index. We DO want it to be
    // deterministic where possible — use a fixed author/committer so two
    // snapshots of identical content produce the same commit sha (the
    // tree sha is already identical; matching commit shas help dedup).
    // Constant message + deterministic author/committer date below — so
    // two snapshots of identical content produce the SAME commit sha. The
    // dedup path in `takeCheckpoint` relies on this: when nothing changed
    // between captures, every repo's recomputed sha matches the previous
    // entry and the new manifest row is discarded. (The id isn't in the
    // message; it lives in the ref name + manifest entry.)
    const commitArgs = ['commit-tree', treeSha, '-m', 'wd checkpoint'];
    if (hasHead) commitArgs.push('-p', headSha);
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'wd',
      GIT_AUTHOR_EMAIL: 'wd@local',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'wd',
      GIT_COMMITTER_EMAIL: 'wd@local',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    const commit = spawn.sync('git', commitArgs, {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: commitEnv,
      windowsHide: true,
    });
    if (commit.status !== 0 || !commit.stdout) return null;
    const commitSha = commit.stdout.trim();

    const refName = `refs/wd/${scopeHash}/${id}`;
    const updateRef = spawn.sync(
      'git',
      ['update-ref', refName, commitSha],
      { cwd: repoRoot, encoding: 'utf-8', windowsHide: true },
    );
    if (updateRef.status !== 0) return null;

    return commitSha;
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
    } catch {
      // Temp-file leftover isn't fatal — os will clean it eventually.
    }
  }
}

export interface ScopeRepo {
  name: string;
  root: string;
}

/**
 * Take one checkpoint across every repo in a scope. Returns the appended
 * entry, or null when the snapshot is identical to the previous entry's
 * (every repo's commit sha matches — i.e. nothing changed). The caller
 * uses the null return to skip the SSE broadcast.
 *
 * When this is the first checkpoint for the scope, `label` defaults to
 * "Initial" so the SPA can render it specially.
 */
export async function takeCheckpoint(
  scopeHash: string,
  repos: ScopeRepo[],
  opts: { force?: boolean; label?: string } = {},
): Promise<CheckpointEntry | null> {
  // Entire flow runs under one file lock so concurrent fs-watch fires
  // (or a register-handler racing with a debounced auto-snapshot) can't
  // assign duplicate ids or interleave manifest writes. Snapshot work
  // itself is git-side-effect-safe to concurrent — git's index/ref
  // locking handles same-repo overlap, and our temp `GIT_INDEX_FILE`
  // means the user's real index is untouched either way. We only need
  // the file lock to serialise the *id assignment + ref write + append*
  // triple, which has to be atomic across processes.
  const file = manifestPath(scopeHash);
  ensureFile(file, JSON.stringify(emptyManifest(scopeHash), null, 2));
  return withFileLock(file, () => {
    const manifest = loadManifest(scopeHash);
    const isFirst = manifest.entries.length === 0;
    const nextId = isFirst
      ? 0
      : manifest.entries[manifest.entries.length - 1].id + 1;

    const captured: Record<string, string | null> = {};
    for (const repo of repos) {
      captured[repo.name] = snapshotRepo(repo.root, scopeHash, nextId);
    }

    // Delete `refs/wd/<hash>/<id>` in every listed repo. Used by both
    // the partial-failure bailout and the dedup-cancel path —
    // `update-ref -d` is a no-op on a missing ref, so the same helper
    // covers "rollback what we wrote" and "rollback what we might
    // have written" without needing per-repo state.
    const rollbackRefs = () => {
      const refName = `refs/wd/${scopeHash}/${nextId}`;
      for (const repo of repos) {
        spawn.sync('git', ['update-ref', '-d', refName], {
          cwd: repo.root,
          encoding: 'utf-8',
          windowsHide: true,
        });
      }
    };

    // If any repo snapshot failed (returned null), bail — a partial
    // entry would let range diffs against this id silently produce
    // empty diffs for the failed repos (via the `?? 'HEAD'` fallback
    // in scope-routes) instead of surfacing the problem. The next
    // fs-event will retry.
    if (repos.some((r) => captured[r.name] === null)) {
      rollbackRefs();
      return null;
    }

    // Dedup: when not forced, compare against the previous entry by
    // TREE sha rather than commit sha. Two captures of the same working
    // tree produce identical trees but can have different commit shas
    // (different parent because HEAD moved, different `-p` argument
    // when one capture saw an empty HEAD). Compare-by-tree means we
    // drop checkpoints that didn't actually change any content —
    // exactly what the user expects from "no changes since last snapshot".
    if (!opts.force && !isFirst) {
      const prev = manifest.entries[manifest.entries.length - 1];
      const treeOf = (root: string, commitSha: string | null): string | null => {
        if (!commitSha) return null;
        const r = spawn.sync(
          'git',
          ['rev-parse', `${commitSha}^{tree}`],
          { cwd: root, encoding: 'utf-8', windowsHide: true },
        );
        if (r.status !== 0 || typeof r.stdout !== 'string') return null;
        return r.stdout.trim() || null;
      };
      const allTreesMatch = repos.every((repo) => {
        const curTree = treeOf(repo.root, captured[repo.name]);
        const prevTree = treeOf(repo.root, prev.repos[repo.name] ?? null);
        return curTree !== null && curTree === prevTree;
      });
      if (allTreesMatch) {
        rollbackRefs();
        return null;
      }
    }

    const entry: CheckpointEntry = {
      id: nextId,
      ts: new Date().toISOString(),
      repos: captured,
    };
    const label = opts.label ?? (isFirst ? 'Initial' : undefined);
    if (label) entry.label = label;
    manifest.entries.push(entry);
    atomicWriteFile(file, JSON.stringify(manifest, null, 2));
    return entry;
  });
}

/** Remove the manifest + every ref for this scope. Called when a scope
 *  is explicitly torn down. Best-effort — partial failure leaves orphaned
 *  refs but doesn't otherwise corrupt state. */
export function clearCheckpoints(
  scopeHash: string,
  repoRoots: string[],
): void {
  const manifest = loadManifest(scopeHash);
  for (const root of repoRoots) {
    for (const entry of manifest.entries) {
      const refName = `refs/wd/${scopeHash}/${entry.id}`;
      spawn.sync('git', ['update-ref', '-d', refName], {
        cwd: root,
        encoding: 'utf-8',
        windowsHide: true,
      });
    }
  }
  const file = manifestPath(scopeHash);
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Leave it — next register will overwrite.
    }
  }
}
