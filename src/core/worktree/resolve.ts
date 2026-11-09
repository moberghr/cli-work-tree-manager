import fs from 'node:fs';
import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import { getWorktreeRoot, getMainRepoRoot, getCurrentBranch } from '../git/git.js';
import type { WorktreeSession } from '../sessions/session-types.js';

export interface ProjectTarget {
  isGroup: boolean;
  name: string;
  repoAliases: string[];
}

/**
 * Resolve whether a name is a group or single repo.
 * Returns null if the name is not found in either.
 */
export function resolveProjectTarget(name: string, config: WorkConfig): ProjectTarget | null {
  // Check if it's a group
  if (name in config.groups) {
    return {
      isGroup: true,
      name,
      repoAliases: [...config.groups[name]],
    };
  }

  // Check if it's a repo
  if (name in config.repos) {
    return {
      isGroup: false,
      name,
      repoAliases: [name],
    };
  }

  return null;
}

/** Get all available project/group names. */
export function getAllTargetNames(config: WorkConfig): string[] {
  return [...Object.keys(config.repos), ...Object.keys(config.groups)];
}

/**
 * Match a worktree path against the configured worktrees root to determine the
 * target. The path must be strictly under `worktreesRoot`. The first path
 * segment is either a group name (checked first) or a repo folder basename.
 *
 * Both paths are canonicalized via `realpath` before comparison: git's
 * `--show-toplevel` returns a fully symlink-resolved path, while
 * `config.worktreesRoot` may contain symlinked components (e.g. macOS
 * `/tmp` → `/private/tmp`). Without this they would mismatch. `realpath` is
 * injectable for testability and defaults to fs.realpathSync (falling back to
 * path.resolve if it throws). Returns null if no match.
 */
export function matchTargetByWorktreePath(
  config: WorkConfig,
  absWorktreePath: string,
  realpath: (p: string) => string = safeRealpath,
): { target: string; isGroup: boolean } | null {
  const root = realpath(config.worktreesRoot);
  const wt = realpath(absWorktreePath);

  const rel = path.relative(root, wt);
  // Must be strictly under root (not the root itself, not outside it).
  if (!rel || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }

  const segments = rel.split(path.sep).filter(Boolean);
  if (segments.length === 0) return null;
  const firstSeg = segments[0];

  // Groups checked first.
  if (firstSeg in config.groups) {
    return { target: firstSeg, isGroup: true };
  }

  for (const alias of Object.keys(config.repos)) {
    if (path.basename(config.repos[alias]) === firstSeg) {
      return { target: alias, isGroup: false };
    }
  }

  return null;
}

/**
 * Reverse-map a main-repo root path to a single-repo alias by comparing
 * canonicalized paths. `realpath` is injectable for testability and defaults
 * to fs.realpathSync (falling back to path.resolve if it throws).
 * Cannot resolve a group from git alone. Returns null if no match.
 */
export function matchTargetByRepoRoot(
  config: WorkConfig,
  repoRoot: string,
  realpath: (p: string) => string = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  },
): { target: string; isGroup: false } | null {
  const target = realpath(repoRoot);
  for (const alias of Object.keys(config.repos)) {
    if (realpath(config.repos[alias]) === target) {
      return { target: alias, isGroup: false };
    }
  }
  return null;
}

/** Canonicalize a path via fs.realpathSync, falling back to path.resolve. */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The folder session (a group's, or a repo's made with `sessionFolders`) one
 * of whose checkouts is `worktreeRoot`, or null. Its folder is named after its
 * target, not after the repo found there: a repo added to it (another alias),
 * or an alias whose repo folder has another name, can't be told from the path.
 */
export function folderSessionAt(sessions: WorktreeSession[], worktreeRoot: string): WorktreeSession | null {
  const at = safeRealpath(worktreeRoot);
  const live = sessions.filter((s) => s.isGroup && s.paths.some((p) => safeRealpath(p) === at));
  return live.find((s) => !s.archivedAt) ?? live[0] ?? null;
}

/**
 * Resolve the target, branch, and base-repo status from the current working
 * directory's git worktree. Uses git. Returns an `{ error }` object on failure.
 */
export function resolveFromCwd(
  config: WorkConfig,
  cwd: string,
  /** The sessions to look in first (a folder session's checkout belongs to it). */
  sessions: WorktreeSession[] = [],
): { target: string; isGroup: boolean; branch: string; isBaseRepo: boolean } | { error: string } {
  const worktreeRoot = getWorktreeRoot(cwd);
  if (!worktreeRoot) {
    return { error: 'Not inside a git repository.' };
  }

  const branch = getCurrentBranch(worktreeRoot);
  if (!branch) {
    return {
      error: 'Current worktree is in a detached HEAD state; cannot infer branch.',
    };
  }

  const own = folderSessionAt(sessions, worktreeRoot);
  let match = own ? { target: own.target, isGroup: true } : matchTargetByWorktreePath(config, worktreeRoot);

  if (!match) {
    const mainRoot = getMainRepoRoot(worktreeRoot);
    if (mainRoot) {
      match = matchTargetByRepoRoot(config, mainRoot);
    }
  }

  if (!match) {
    const aliases = Object.keys(config.repos).join(', ');
    return {
      error: `Current directory does not belong to any configured work repo or group. Configured repos: ${aliases}`,
    };
  }

  let isBaseRepo = false;
  if (!match.isGroup) {
    const repoPath = config.repos[match.target];
    if (repoPath && safeRealpath(repoPath) === safeRealpath(worktreeRoot)) {
      isBaseRepo = true;
    }
  }

  return {
    target: match.target,
    isGroup: match.isGroup,
    branch,
    isBaseRepo,
  };
}
