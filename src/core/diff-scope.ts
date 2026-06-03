import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { git } from './git.js';
import { loadHistory, type WorktreeSession } from './history.js';
import type { RepoSpec } from './repo-spec.js';

export interface DiffScope {
  isGroup: boolean;
  session: WorktreeSession | null;
  /** Repos to diff (1 for single, N for group). */
  repos: { name: string; root: string }[];
  /** Name of the repo whose subtree the user is in (initial active tab). */
  activeRepoName: string | null;
}

export interface ResolvedBase {
  base: string;
  source: 'arg' | 'session' | 'auto-detected' | 'default';
}

function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/**
 * Like {@link normPath} but resolves symlinks. `git rev-parse --show-toplevel`
 * returns the realpath (e.g. macOS `/var` → `/private/var`), so comparing it
 * to a stored session path must go through realpath on both sides. Falls back
 * to {@link normPath} for paths that don't exist (e.g. unit-test fixtures).
 */
function realNorm(p: string): string {
  try {
    return normPath(fs.realpathSync(p));
  } catch {
    return normPath(p);
  }
}

/**
 * Resolve what scope to diff based on cwd. Handles single-repo worktrees,
 * group worktrees (cwd at group root or anywhere inside a sub-repo), and
 * "random" git repos not managed by `work`.
 */
export function resolveScope(cwd: string): DiffScope | null {
  const normCwd = normPath(cwd);
  const sessions = loadHistory();

  // cwd's own git worktree root. Used to reject session-path matches that are
  // really a *parent* repo: linked worktrees often live physically inside
  // another repo (e.g. `<repo>/.claude/worktrees/<branch>`), so a naive prefix
  // match collapses every nested worktree onto the parent's scope — they'd
  // share one daemon and show each other's diff.
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  const toplevel = top.exitCode === 0 && top.stdout ? top.stdout : null;
  const realTop = toplevel ? realNorm(toplevel) : null;

  // 1. cwd is at or inside one of a session's repo paths.
  for (const s of sessions) {
    for (const p of s.paths) {
      const np = normPath(p);
      if (normCwd === np || normCwd.startsWith(np + '/')) {
        // Only honour the match if this session path is cwd's actual worktree
        // root. When cwd is in a nested worktree, its toplevel is deeper than
        // `np` — skip so we resolve the real (nested) worktree below.
        if (realTop && realNorm(p) !== realTop) continue;
        if (s.isGroup) {
          return {
            isGroup: true,
            session: s,
            repos: s.paths.map((rp) => ({ name: path.basename(rp), root: rp })),
            activeRepoName: path.basename(p),
          };
        }
        return {
          isGroup: false,
          session: s,
          repos: [{ name: path.basename(p), root: p }],
          activeRepoName: path.basename(p),
        };
      }
    }
  }

  // 2. cwd is at the group root (parent of all of a group's repo paths).
  for (const s of sessions) {
    if (!s.isGroup || s.paths.length === 0) continue;
    const parents = s.paths.map((p) => normPath(path.dirname(p)));
    const groupRoot = parents[0];
    if (!parents.every((par) => par === groupRoot)) continue;
    if (normCwd === groupRoot || normCwd.startsWith(groupRoot + '/')) {
      return {
        isGroup: true,
        session: s,
        repos: s.paths.map((rp) => ({ name: path.basename(rp), root: rp })),
        activeRepoName: null,
      };
    }
  }

  // 3. Fall back to git rev-parse for repos not managed by `work`.
  if (!toplevel) return null;
  return {
    isGroup: false,
    session: null,
    repos: [{ name: path.basename(toplevel), root: toplevel }],
    activeRepoName: path.basename(toplevel),
  };
}

/**
 * Find any plausible parent branch — same candidate list as
 * `detectParentBranch`, but DOESN'T require the parent to have commits
 * past HEAD. Returns the candidate with the most-recent merge-base (or
 * null only if no candidates exist at all).
 *
 * Used by the static renderer and the diff server's `?base=branch`
 * route to decide whether to offer the "Since branch" tab. `detectParentBranch`
 * skips parents where merge-base == HEAD (correct for the CLI's "show
 * me what I added past parent" semantic — empty diff), but the toggle
 * should still appear in that case so the user can confirm "no, there's
 * nothing committed yet".
 */
export function findAnyParentBranch(cwd: string): string | null {
  return findParent(cwd, false);
}

/** Walk candidate base branches and pick the one with the most recent merge-base. */
export function detectParentBranch(cwd: string): string | null {
  return findParent(cwd, true);
}

function findParent(cwd: string, requireAheadOfParent: boolean): string | null {
  const currentResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const currentBranch = currentResult.exitCode === 0 ? currentResult.stdout : '';

  const candidates = ['main', 'master', 'dev', 'develop'].flatMap((name) => [
    name,
    `origin/${name}`,
  ]);

  let best: { ref: string; sha: string; time: number } | null = null;

  for (const ref of candidates) {
    if (ref === currentBranch) continue;
    const exists = git(['rev-parse', '--verify', '--quiet', ref], cwd);
    if (exists.exitCode !== 0 || !exists.stdout) continue;

    const mb = git(['merge-base', ref, 'HEAD'], cwd);
    if (mb.exitCode !== 0 || !mb.stdout) continue;

    // Skip parents where the merge-base IS HEAD only when the caller
    // asked us to (CLI "show me what I added" semantics). When called
    // for the toggle UI, we want to surface the parent even though the
    // diff will be empty.
    if (requireAheadOfParent) {
      const headSha = git(['rev-parse', 'HEAD'], cwd).stdout;
      if (mb.stdout === headSha) continue;
    }

    const timeResult = git(['show', '-s', '--format=%ct', mb.stdout], cwd);
    if (timeResult.exitCode !== 0) continue;
    const time = Number(timeResult.stdout);
    if (!Number.isFinite(time)) continue;

    if (!best || time > best.time) {
      best = { ref, sha: mb.stdout, time };
    }
  }

  return best?.ref ?? null;
}

export function resolveBase(
  scope: DiffScope,
  argv: { base?: string; branch?: boolean },
): ResolvedBase {
  if (argv.base) return { base: argv.base, source: 'arg' };

  if (argv.branch) {
    if (scope.session?.baseBranch) {
      return { base: scope.session.baseBranch, source: 'session' };
    }
    const primaryRoot =
      scope.repos.find((r) => r.name === scope.activeRepoName)?.root ??
      scope.repos[0].root;
    const detected = detectParentBranch(primaryRoot);
    if (detected) return { base: detected, source: 'auto-detected' };

    console.error(
      chalk.red('Could not determine a parent branch for this worktree.'),
    );
    console.error(chalk.gray('Pass one explicitly: diff <ref>'));
    process.exit(1);
  }

  return { base: 'HEAD', source: 'default' };
}

/** Compute per-repo merge-base when comparing against a non-HEAD ref. */
export function buildRepoSpecs(scope: DiffScope, base: string): RepoSpec[] {
  return scope.repos.map((r) => {
    let diffArg = base;
    if (base !== 'HEAD') {
      const mb = git(['merge-base', base, 'HEAD'], r.root);
      if (mb.exitCode === 0 && mb.stdout) diffArg = mb.stdout;
    }
    return { name: r.name, root: r.root, diffArg };
  });
}

export interface ResolvedRepoDiff {
  /** The git ref the diff was computed against. `HEAD` for uncommitted,
   *  the resolved parent (e.g. `origin/main`) for branch mode. */
  resolvedBase: string;
  /** The actual argument passed to `git diff` — typically the merge-base
   *  sha for branch mode, or `HEAD` for uncommitted. */
  diffArg: string;
}

/**
 * Resolve the diff target for a single repo. Centralises the
 * "find-parent → merge-base → fall back to HEAD" dance that previously
 * lived in three places (scope-routes, web-server, the static renderer).
 *
 * For `base === 'uncommitted'` this is trivially `HEAD`. For
 * `base === 'branch'` it prefers an explicit `sessionBaseBranch` (the
 * value the user recorded with `work tree --base`), falling back to
 * `findAnyParentBranch` (so the toggle stays available even when the
 * branch has no commits past parent yet — diff just renders empty).
 */
export function resolveRepoDiff(
  root: string,
  base: 'uncommitted' | 'branch',
  sessionBaseBranch?: string | null,
): ResolvedRepoDiff {
  if (base === 'uncommitted') {
    return { resolvedBase: 'HEAD', diffArg: 'HEAD' };
  }
  // Prefer a parent we're actually *ahead of* (`detectParentBranch` skips
  // candidates whose merge-base is HEAD, e.g. a `dev` that already contains
  // this branch). `findAnyParentBranch` would pick the most-recent merge-base
  // even when it's HEAD — yielding a useless 0-commit "since branch" diff.
  // Fall back to it only so the toggle still resolves to *something*.
  const parent =
    sessionBaseBranch ?? detectParentBranch(root) ?? findAnyParentBranch(root);
  if (!parent) return { resolvedBase: 'HEAD', diffArg: 'HEAD' };
  let diffArg = 'HEAD';
  const mb = git(['merge-base', parent, 'HEAD'], root);
  if (mb.exitCode === 0 && mb.stdout) diffArg = mb.stdout;
  return { resolvedBase: parent, diffArg };
}
