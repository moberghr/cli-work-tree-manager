import fs from 'node:fs';
import path from 'node:path';
import { debug } from './logger.js';
import type { WorkConfig } from './config.js';
import { getConfigDir } from './config.js';
import { resolveProjectTarget } from './resolve.js';
import { findSession, loadHistory, upsertSession, upsertSessionWithPort, setSessionTitle, forgetOtherBaseCheckoutEntries } from './history.js';
import { bestEffort } from './best-effort.js';
import { readArchive, restoreArchivedTranscripts } from './session-archive.js';
import { sessionIdFor } from './session-id.js';
import {
  git,
  parseWorktreeList,
  localBranchExists,
  remoteBranchExists,
  isGitRepo,
  getCurrentBranch,
  getStatusChecked,
  repoState,
  getUnpushedCommits,
} from './git.js';
import { copyConfigFiles } from './copy-files.js';
import {
  type BaseSpec,
  baseForAlias,
  baseSpecOverrideAliases,
  isEmptyBaseSpec,
  toBaseSpec,
} from './base-spec.js';
import { report } from './report.js';

/**
 * Pull latest changes for a checkout we're switching into (a worktree that
 * already existed, or the base repo). Runs fetch + pull in that directory.
 * Best-effort: a branch with no upstream is skipped silently; a failed pull
 * (dirty tree, conflicts) only warns and never blocks the switch.
 */
export function pullLatestForBranch(worktreePath: string, branchName: string): void {
  // Skip purely local branches — `git pull` would print a "no tracking
  // information" error that reads as a failure rather than a no-op.
  const upstream = git(
    ['rev-parse', '--abbrev-ref', `${branchName}@{upstream}`],
    worktreePath,
  );
  if (upstream.exitCode !== 0) return;

  report('info', `  Pulling latest changes for ${branchName}...`);
  // Fetch first so origin/* is fresh even if the pull below can't fast-forward.
  git(['fetch', '--quiet'], worktreePath);
  const pull = git(['pull', '--quiet'], worktreePath);
  if (pull.exitCode !== 0) {
    report('warn', `  ⚠ Could not pull '${branchName}' (uncommitted changes or conflicts). Worktree may be behind origin.`);
    const firstErrLine = pull.stderr.split('\n')[0];
    if (firstErrLine) report('detail', `    ${firstErrLine}`);
  }
}

/**
 * Create a single git worktree for one repo.
 * Returns true on success, false on failure.
 *
 * When `baseBranch` is provided, the new branch is created from that base
 * instead of HEAD. Only valid for new branches — errors if the target branch
 * already exists locally or on remote.
 *
 * `pull` (default true) only affects the already-exists path: a freshly created
 * worktree is at its branch tip anyway.
 */
/** Same folder: git prints forward slashes and long names on Windows, where a path may come as a short 8.3 name or in another case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync.native(r);
    } catch {
      /* not there: as given */
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function createSingleWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  config: WorkConfig,
  baseBranch?: string,
  pull = true,
): boolean {
  debug('createSingleWorktree', { repoPath, worktreePath, branchName, baseBranch });

  // Check if the worktree already exists at the target path (idempotent re-run)
  if (fs.existsSync(worktreePath)) {
    if (isGitRepo(worktreePath)) {
      const currentBranch = getCurrentBranch(worktreePath);
      if (currentBranch === branchName) {
        report('warn', `  Worktree already exists at: ${worktreePath}`);
        if (pull) pullLatestForBranch(worktreePath, branchName);
        return true;
      }
      // This repo's worktree, on another branch now (Claude or you switched
      // it): it is the session's checkout, used as it is. `git worktree add`
      // into it would fail, and re-entering or restoring the session with it.
      const ours = parseWorktreeList(repoPath).some((wt) => samePath(wt.path, worktreePath));
      if (ours) {
        report('warn', `  Worktree already exists at: ${worktreePath} (on ${currentBranch ?? 'a detached HEAD'}, not ${branchName}: using it as it is)`);
        if (pull && currentBranch) pullLatestForBranch(worktreePath, currentBranch);
        return true;
      }
    }
  }

  // Check if the branch is already checked out in another worktree
  const worktrees = parseWorktreeList(repoPath);
  const existingForBranch = worktrees.find(
    (wt) => wt.branch === branchName && wt.path !== worktreePath,
  );

  if (existingForBranch) {
    report('error', `  Branch '${branchName}' is already checked out in a worktree at: ${existingForBranch.path}`);
    report('error', '  Remove that worktree first, or use the existing one.');
    return false;
  }

  // Create parent directory
  const parentDir = path.dirname(worktreePath);
  fs.mkdirSync(parentDir, { recursive: true });

  // Fetch remote refs first so origin/* is up to date even if pull fails below
  git(['fetch', '--quiet'], repoPath);

  // Pull latest changes for current branch in main repo
  const baseRepoBranch = getCurrentBranch(repoPath);
  const baseBranchLabel = baseRepoBranch ?? '(detached HEAD)';
  report('info', `  Pulling latest changes for main repo (on ${baseBranchLabel})...`);
  if (baseRepoBranch && !['master', 'main', 'dev'].includes(baseRepoBranch)) {
    report('warn', `  ⚠ Warning: base repo is on '${baseRepoBranch}', not master/main/dev`);
  }
  const baseRepoPull = git(['pull', '--quiet'], repoPath);
  const baseRepoPullFailed = baseRepoPull.exitCode !== 0;
  if (baseRepoPullFailed) {
    report('warn', `  ⚠ Could not pull '${baseBranchLabel}' (uncommitted changes, conflicts, or no upstream).`);
    const firstErrLine = baseRepoPull.stderr.split('\n')[0];
    if (firstErrLine) report('detail', `    ${firstErrLine}`);
  }

  const hasLocal = localBranchExists(branchName, repoPath);
  const hasRemote = remoteBranchExists(branchName, repoPath);

  // --base requires a brand-new branch
  if (baseBranch && (hasLocal || hasRemote)) {
    report('error', `  Cannot use --base: branch '${branchName}' already exists ${hasLocal ? 'locally' : 'on remote'}`);
    return false;
  }

  // Pull latest changes if branch exists locally
  if (hasLocal) {
    report('info', `  Pulling latest changes for ${branchName}...`);
    const prevBranch = getCurrentBranch(repoPath);
    git(['checkout', branchName, '--quiet'], repoPath);
    const branchPull = git(['pull', '--quiet'], repoPath);
    if (branchPull.exitCode !== 0) {
      report('warn', `  ⚠ Could not pull '${branchName}'. Worktree may be behind origin.`);
      const firstErrLine = branchPull.stderr.split('\n')[0];
      if (firstErrLine) report('detail', `    ${firstErrLine}`);
    }
    if (prevBranch) {
      git(['checkout', prevBranch, '--quiet'], repoPath);
    }
  }

  // Create worktree
  let result;
  let branchSource: 'local' | 'remote' | 'new' = 'new';
  if (hasLocal || hasRemote) {
    if (hasRemote && !hasLocal) {
      branchSource = 'remote';
      result = git(
        [
          'worktree',
          'add',
          worktreePath,
          '-b',
          branchName,
          '--track',
          `origin/${branchName}`,
        ],
        repoPath,
      );
    } else {
      branchSource = 'local';
      result = git(
        ['worktree', 'add', worktreePath, branchName],
        repoPath,
      );
    }
  } else if (baseBranch) {
    // Validate the base branch exists
    const baseLocal = localBranchExists(baseBranch, repoPath);
    const baseRemote = remoteBranchExists(baseBranch, repoPath);

    if (!baseLocal && !baseRemote) {
      report('error', `  Base branch '${baseBranch}' does not exist locally or on remote`);
      return false;
    }

    const baseRef = baseLocal ? baseBranch : `origin/${baseBranch}`;
    result = git(
      ['worktree', 'add', worktreePath, '-b', branchName, baseRef],
      repoPath,
    );
  } else {
    // If pulling the base repo branch failed, use origin/<baseRepoBranch> as the
    // source so the new branch isn't created from a stale local HEAD.
    const fallbackToRemote =
      baseRepoPullFailed &&
      !!baseRepoBranch &&
      remoteBranchExists(baseRepoBranch, repoPath);
    if (fallbackToRemote) {
      report('step', `  Using origin/${baseRepoBranch} as base (local '${baseRepoBranch}' is stale)`);
      result = git(
        ['worktree', 'add', worktreePath, '-b', branchName, `origin/${baseRepoBranch}`],
        repoPath,
      );
    } else {
      result = git(
        ['worktree', 'add', worktreePath, '-b', branchName],
        repoPath,
      );
    }
  }

  if (result.exitCode !== 0) {
    debug('git worktree add failed', { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    report('error', '  Failed to create worktree');
    if (result.stderr) {
      report('error', `  ${result.stderr}`);
    }
    return false;
  }

  // Copy configuration files from main repo
  if (config.copyFiles && config.copyFiles.length > 0) {
    copyConfigFiles(repoPath, worktreePath, config.copyFiles);
  }

  if (branchSource === 'remote') {
    report('step', `  Tracking remote branch origin/${branchName}`);
  } else if (branchSource === 'local') {
    report('step', `  Using existing local branch ${branchName}`);
  } else if (baseBranch) {
    report('step', `  Created new branch ${branchName} from ${baseBranch}`);
  } else {
    report('step', `  Created new branch ${branchName}`);
  }

  report('success', `  Created worktree: ${worktreePath}`);
  return true;
}

/**
 * Remove a single git worktree.
 * Returns true on success, false if blocked (uncommitted/unpushed changes).
 */
/**
 * Would `removeSingleWorktree(…, force)` refuse this worktree? Same checks,
 * no side effects — lets callers stop the session's Claude only when the
 * worktree is really going away (a refused non-forced removal must leave
 * the running agent alone).
 */
export function wouldRefuseRemoval(worktreePath: string, force: boolean): boolean {
  if (force || !fs.existsSync(worktreePath)) return false;
  const state = repoState(worktreePath);
  if (state === 'not-a-repo') return false;
  if (state === 'unknown') return true; // git can't read it: can't prove it's safe
  const status = getStatusChecked(worktreePath);
  if (status === null) return true;
  return !!status || !!getUnpushedCommits(worktreePath);
}

/**
 * git got through its checks and failed while deleting the files (a path too
 * long for Windows, a file another program holds) — as opposed to refusing
 * ("contains modified or untracked files", "is locked").
 */
export function isDeleteFailure(stderr: string): boolean {
  return /failed to delete/i.test(stderr);
}

export function removeSingleWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  force: boolean,
): boolean {
  if (!fs.existsSync(worktreePath)) {
    report('warn', `  Worktree does not exist at: ${worktreePath}`);
    return true; // Nothing to remove is success
  }

  // A folder that is definitely not a git checkout (a leftover) is just
  // deleted. One git merely failed to read is NOT: without --force it's
  // refused, because every check below would read as "clean".
  const state = repoState(worktreePath);
  if (state === 'not-a-repo') {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    git(['worktree', 'prune'], repoPath);
    report('info', `  Removed invalid worktree directory: ${worktreePath}`);
    return true;
  }
  if (state === 'unknown' && !force) {
    report('warn', `  git can't read ${worktreePath} (ownership, a moved main repo, git not on PATH?) — not removing it. Check it, or use --force.`);
    return false;
  }

  if (!force) {
    // Check for uncommitted changes
    const status = getStatusChecked(worktreePath);
    if (status === null) {
      report('warn', `  Could not check ${worktreePath} for uncommitted changes — not removing it.`);
      return false;
    }
    if (status) {
      report('warn', `  Uncommitted changes in: ${worktreePath}`);
      report('info', status);
      return false;
    }

    // Check for unpushed commits
    const unpushed = getUnpushedCommits(worktreePath);
    if (unpushed) {
      report('warn', `  Unpushed commits in: ${worktreePath}`);
      report('info', unpushed);
      return false;
    }
  }

  // core.longpaths: a worktree's node_modules / bin / obj easily pass
  // Windows' 260-character limit, and without it git stops half way with
  // "Filename too long" (a no-op elsewhere).
  const args = force
    ? ['-c', 'core.longpaths=true', 'worktree', 'remove', worktreePath, '--force']
    : ['-c', 'core.longpaths=true', 'worktree', 'remove', worktreePath];

  const result = git(args, repoPath);

  if (result.exitCode === 0) {
    report('success', `  Removed worktree: ${worktreePath}`);
    return true;
  } else if (isDeleteFailure(result.stderr)) {
    // git had passed its own checks (and ours above) and failed while
    // deleting files: finish the delete ourselves — Node handles long paths —
    // then let git forget the registration. A git REFUSAL never gets here.
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err) {
      report('error', `  Failed to remove worktree: ${worktreePath}`);
      report('error', `  ${(err as Error).message}`);
      return false;
    }
    git(['worktree', 'prune'], repoPath);
    const why = result.stderr.split('\n')[0].replace(/^error:\s*/, '');
    report('success', `  Removed worktree: ${worktreePath} (finished the delete git could not: ${why})`);
    return true;
  } else if (force && state === 'unknown') {
    // git can't handle it (its main repo moved, say) and the user forced
    // it: delete the folder, then let git forget the registration.
    fs.rmSync(worktreePath, { recursive: true, force: true });
    git(['worktree', 'prune'], repoPath);
    report('success', `  Removed worktree folder git could not read: ${worktreePath}`);
    return true;
  } else {
    report('error', `  Failed to remove worktree: ${worktreePath}`);
    if (result.stderr) {
      report('error', `  ${result.stderr}`);
    }
    return false;
  }
}

/** Caller-tunable behavior for {@link setupWorktree}. */
export interface WorktreeSetupOptions {
  /**
   * Pull latest changes when switching into a worktree that already exists.
   * Default true; `work tree --no-pull` turns it off.
   */
  pull?: boolean;
  /**
   * Per repo alias: the branch to check out instead of the session's — set
   * when restoring an archived session whose worktree was removed while on
   * another branch (archive.json `heads`). The folder keeps the session's name.
   */
  checkoutFor?: Record<string, string>;
  /** Name the session (its title, shown instead of the branch); empty keeps what it has. */
  name?: string;
}

/**
 * Result of setupWorktree — everything needed to launch an AI session.
 */
export interface WorktreeSetupResult {
  /** Directory to launch the AI tool in. */
  launchDir: string;
  /** All worktree paths created/found (for session tracking). */
  paths: string[];
  /** Whether the target is a group. */
  isGroup: boolean;
  /** Stable dev-server port allocated to this worktree, if allocation succeeded. */
  port?: number;
}

/**
 * High-level worktree setup: resolve target, create worktree(s), copy group
 * CLAUDE.md, and record the session. Used by both the CLI command and the TUI.
 *
 * Returns the setup result on success, or null on failure.
 */
export async function setupWorktree(
  targetName: string,
  branchName: string,
  config: WorkConfig,
  base?: string | BaseSpec,
  jiraKey?: string,
  opts: WorktreeSetupOptions = {},
): Promise<WorktreeSetupResult | null> {
  const spec = toBaseSpec(base);
  debug('setupWorktree', { targetName, branchName, spec, jiraKey, opts });
  const target = resolveProjectTarget(targetName, config);
  if (!target) { debug('setupWorktree: target not found', targetName); return null; }

  const workTreeDirName = branchName.replace(/\//g, '-');

  // Coming back to an archived session whose merged branch archiving
  // deleted: put the branch back at the tip it had, so the worktree is that
  // work (branch resolution would otherwise start a new branch from base).
  bestEffort('recreate the archived branch', () =>
    recreateArchivedBranches(target.isGroup ? target.name : targetName, branchName, target.repoAliases, config),
  );
  // And its worktree comes back on the branch it was on (Claude may have
  // switched from the session's), not a new one of the session's name.
  const checkoutFor = opts.checkoutFor ?? archivedHeads(target.isGroup ? target.name : targetName, branchName);
  if (checkoutFor) opts = { ...opts, checkoutFor };

  const result = target.isGroup
    ? await setupGroupWorktree(target.name, target.repoAliases, branchName, workTreeDirName, config, spec, jiraKey, opts)
    : await setupSingleWorktree(targetName, branchName, workTreeDirName, config, spec, jiraKey, opts);
  // Coming back to an archived session: put its conversation back where
  // Claude looks for it (only files that aren't there), so it continues.
  if (result) {
    const sessionTarget = target.isGroup ? target.name : targetName;
    const session = findSession(loadHistory(), sessionTarget, branchName);
    if (session) bestEffort('restore the archived conversation', () => restoreArchivedTranscripts(session), 0);
    if (opts.name?.trim()) await setSessionTitle(sessionTarget, branchName, opts.name);
  }
  return result;
}

/**
 * For each repo whose local branch archiving deleted (archive.json
 * `branchesDeleted`): recreate it at the recorded tip when neither a local
 * nor a remote branch of that name exists and the commit is still there.
 * Returns the aliases it recreated the branch in.
 */
export function recreateArchivedBranches(sessionTarget: string, branch: string, aliases: string[], config: WorkConfig): string[] {
  const session = findSession(loadHistory(), sessionTarget, branch);
  if (!session) return [];
  const rec = readArchive(sessionIdFor(session));
  if (!rec?.tips || !rec.branchesDeleted?.length) return [];
  const done: string[] = [];
  for (const alias of aliases) {
    const repo = config.repos[alias];
    const tip = rec.tips[alias];
    // The branch it was on: the session's, or the one Claude switched to.
    const name = rec.heads?.[alias] ?? branch;
    if (!repo || !tip || !rec.branchesDeleted.includes(alias)) continue;
    if (localBranchExists(name, repo) || remoteBranchExists(name, repo)) continue;
    if (git(['cat-file', '-e', `${tip}^{commit}`], repo).exitCode !== 0) continue;
    if (git(['branch', name, tip], repo).exitCode === 0) done.push(alias);
  }
  return done;
}

/**
 * An archived session whose worktree was removed while (some of) its repos
 * were on another branch: alias → that branch, for setupWorktree to check
 * out. Undefined otherwise (the worktree was kept, or on the session's branch).
 */
export function archivedHeads(sessionTarget: string, branch: string): Record<string, string> | undefined {
  const session = findSession(loadHistory(), sessionTarget, branch);
  if (!session?.archivedAt) return undefined;
  const rec = readArchive(sessionIdFor(session));
  return rec?.worktreeRemoved && rec.heads && Object.keys(rec.heads).length ? rec.heads : undefined;
}

async function setupGroupWorktree(
  groupName: string,
  repoAliases: string[],
  branchName: string,
  workTreeDirName: string,
  config: WorkConfig,
  spec: BaseSpec,
  jiraKey?: string,
  opts: WorktreeSetupOptions = {},
): Promise<WorktreeSetupResult | null> {
  const groupWorktreePath = path.join(config.worktreesRoot, groupName, workTreeDirName);

  // Pre-validate --base across all repos before creating anything. Each repo
  // resolves its own base: a per-repo override (`alias=branch`) if present,
  // otherwise the bare default.
  if (!isEmptyBaseSpec(spec)) {
    const unknownAliases = baseSpecOverrideAliases(spec).filter(
      (a) => !repoAliases.includes(a),
    );
    if (unknownAliases.length > 0) {
      report('error', `--base names repo(s) not in group '${groupName}': ${unknownAliases.join(', ')}. Group repos: ${repoAliases.join(', ')}`);
      return null;
    }

    const missingBase: string[] = [];
    const branchExists: string[] = [];

    for (const alias of repoAliases) {
      const repoPath = config.repos[alias];
      const repoBase = baseForAlias(spec, alias);
      if (!repoBase) continue; // no base applied to this repo → forks HEAD
      if (!localBranchExists(repoBase, repoPath) && !remoteBranchExists(repoBase, repoPath)) {
        missingBase.push(`${alias} (${repoBase})`);
      }
      if (localBranchExists(branchName, repoPath) || remoteBranchExists(branchName, repoPath)) {
        branchExists.push(alias);
      }
    }

    if (missingBase.length > 0) {
      report('error', `Base branch not found in: ${missingBase.join(', ')}`);
      return null;
    }
    if (branchExists.length > 0) {
      report('error', `Cannot use --base: branch '${branchName}' already exists in: ${branchExists.join(', ')}`);
      return null;
    }
  }

  report('step', `Creating group worktree: ${groupName}/${branchName}`);
  report('detail', `Directory: ${groupWorktreePath}`);
  report('info', '');

  fs.mkdirSync(groupWorktreePath, { recursive: true });

  const createdWorktrees: Array<{ repoPath: string; worktreePath: string }> = [];
  // Per-repo fork point, keyed by worktree path (matches the session `paths`).
  const baseBranches: Record<string, string> = {};

  for (const alias of repoAliases) {
    const repoPath = config.repos[alias];
    const repoName = path.basename(repoPath);
    const subWorktreePath = path.join(groupWorktreePath, repoName);
    const repoBase = baseForAlias(spec, alias);

    report('step', `[${alias}] (${repoName}):`);
    const success = createSingleWorktree(repoPath, subWorktreePath, opts.checkoutFor?.[alias] ?? branchName, config, repoBase, opts.pull !== false);

    if (success) {
      createdWorktrees.push({ repoPath, worktreePath: subWorktreePath });
      if (repoBase) baseBranches[subWorktreePath] = repoBase;
    } else {
      // Rollback
      report('info', '');
      report('warn', 'Rolling back created worktrees due to failure...');
      for (const wt of createdWorktrees) {
        removeSingleWorktree(wt.repoPath, wt.worktreePath, branchName, true);
      }
      try {
        if (fs.readdirSync(groupWorktreePath).length === 0) {
          fs.rmSync(groupWorktreePath, { recursive: true, force: true });
        }
      } catch { /* */ }
      report('error', 'Failed to create group worktree. Changes have been rolled back.');
      return null;
    }
  }

  // Copy group CLAUDE.md
  const configDir = getConfigDir();
  const claudeMdSrc = path.join(configDir, `${groupName}.claude.md`);
  const claudeMdDest = path.join(groupWorktreePath, 'CLAUDE.md');

  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, claudeMdDest);
    report('info', '');
    report('success', 'Copied group CLAUDE.md to worktree root');
  } else {
    report('info', '');
    report('warn', `Warning: Group CLAUDE.md not found at ${claudeMdSrc}`);
    report('warn', `Run 'work config regengroup ${groupName}' to generate it.`);
  }

  const allPaths = createdWorktrees.map((wt) => wt.worktreePath);
  // Representative base for the single-line "vs X" badge: the explicit
  // default, else a per-repo value only when every repo shares it.
  const distinctBases = [...new Set(Object.values(baseBranches))];
  const representativeBase =
    spec.default ?? (distinctBases.length === 1 ? distinctBases[0] : undefined);
  const { port } = await upsertSessionWithPort(
    groupName,
    true,
    branchName,
    allPaths,
    config,
    jiraKey,
    representativeBase,
    baseBranches,
  );

  report('info', '');
  report('info', `Branch: ${branchName}`);
  if (port !== undefined) report('detail', `Dev-server port: ${port}`);

  return { launchDir: groupWorktreePath, paths: allPaths, isGroup: true, port };
}

async function setupSingleWorktree(
  targetName: string,
  branchName: string,
  workTreeDirName: string,
  config: WorkConfig,
  spec: BaseSpec,
  jiraKey?: string,
  opts: WorktreeSetupOptions = {},
): Promise<WorktreeSetupResult | null> {
  const repoPath = config.repos[targetName];
  const repoName = path.basename(repoPath);
  let workTreePath = path.join(config.worktreesRoot, repoName, workTreeDirName);

  // For a single repo, the only valid per-repo override alias is the target.
  const unknownAliases = baseSpecOverrideAliases(spec).filter((a) => a !== targetName);
  if (unknownAliases.length > 0) {
    report('error', `--base names repo(s) other than '${targetName}': ${unknownAliases.join(', ')}`);
    return null;
  }
  const baseBranch = baseForAlias(spec, targetName);

  if (!fs.existsSync(repoPath)) {
    report('error', `Repository path does not exist: ${repoPath}`);
    return null;
  }

  // Check for existing worktree at any path
  const worktrees = parseWorktreeList(repoPath);
  const existing = worktrees.find(
    (wt) =>
      wt.branch === branchName &&
      path.resolve(wt.path) !== path.resolve(repoPath),
  );

  if (existing) {
    if (baseBranch) {
      report('error', `Cannot use --base: worktree for '${branchName}' already exists at ${existing.path}`);
      return null;
    }
    report('info', `Worktree already exists at: ${existing.path}`);
    workTreePath = existing.path;
    if (opts.pull !== false) pullLatestForBranch(workTreePath, branchName);
  } else {
    const success = createSingleWorktree(repoPath, workTreePath, opts.checkoutFor?.[targetName] ?? branchName, config, baseBranch, opts.pull !== false);
    if (!success) return null;
  }

  const { port } = await upsertSessionWithPort(
    targetName,
    false,
    branchName,
    [workTreePath],
    config,
    jiraKey,
    baseBranch,
    baseBranch ? { [workTreePath]: baseBranch } : undefined,
  );

  report('info', `Branch: ${branchName}`);
  if (port !== undefined) report('detail', `Dev-server port: ${port}`);

  return { launchDir: workTreePath, paths: [workTreePath], isGroup: false, port };
}

/**
 * Remove all worktrees for a session and clean up.
 * Returns true if all worktrees were successfully removed.
 * When force=false, stops on uncommitted/unpushed changes.
 */
/** For comparing folders: absolute, long-form (Windows 8.3 names expanded), `/`, case-folded. */
const normalizeWorktreePath = (p: string): string => {
  let full = path.resolve(p);
  try {
    full = fs.realpathSync.native(full);
  } catch {
    /* gone: compare as given */
  }
  return full.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
};

export function teardownWorktree(
  target: string,
  isGroup: boolean,
  branch: string,
  config: WorkConfig,
  force: boolean = true,
  /** The session's folders, when the caller knows them: the worktree is the
   *  one AT that folder, whatever branch is checked out there now (you may
   *  have switched branches inside it). Without them, found by branch. */
  paths?: string[],
): boolean {
  const workTreeDirName = branch.replace(/\//g, '-');

  if (isGroup && config.groups[target]) {
    const aliases = config.groups[target];
    const groupWorktreePath = path.join(config.worktreesRoot, target, workTreeDirName);
    let allRemoved = true;

    for (const alias of aliases) {
      const repoPath = config.repos[alias];
      if (!repoPath) continue;
      const repoName = path.basename(repoPath);
      const subWorktreePath = path.join(groupWorktreePath, repoName);
      report('step', `[${alias}] (${repoName}):`);
      if (!removeSingleWorktree(repoPath, subWorktreePath, branch, force)) {
        allRemoved = false;
      }
    }

    // Clean up group CLAUDE.md and empty parent dir
    const claudeMd = path.join(groupWorktreePath, 'CLAUDE.md');
    try { if (fs.existsSync(claudeMd)) fs.unlinkSync(claudeMd); } catch { /* */ }
    try {
      if (fs.existsSync(groupWorktreePath) && fs.readdirSync(groupWorktreePath).length === 0) {
        fs.rmSync(groupWorktreePath, { recursive: true, force: true });
        report('success', `Cleaned up group directory: ${groupWorktreePath}`);
      }
    } catch { /* */ }

    return allRemoved;
  } else {
    const repoPath = config.repos[target];
    if (repoPath) {
      const worktrees = parseWorktreeList(repoPath);
      const at = paths?.[0] ? normalizeWorktreePath(paths[0]) : null;
      const wt = (at ? worktrees.find((w) => normalizeWorktreePath(w.path) === at) : undefined) ?? worktrees.find((w) => w.branch === branch);
      if (wt) {
        return removeSingleWorktree(repoPath, wt.path, branch, force);
      }
    }
    report('warn', `No worktree found for branch '${branch}' in '${target}'.`);
    return false;
  }
}

/** What opening a repo's own checkout gave: the session it is, or why not. */
export type BaseCheckoutResult = { ok: true; repoPath: string; branch: string; dropped: string[] } | { ok: false; error: string };

/**
 * Work on a repo's own checkout, on whatever branch it has (`work tree
 * <repo>` with no branch, or the New worktree dialog with the branch left
 * empty): no worktree, the session is the checkout itself. Pulls first
 * (unless `pull: false`), and drops the entries recorded for this checkout
 * when it was on another branch — one session per checkout. A group has no
 * single checkout: it needs a branch.
 */
export async function openBaseCheckout(
  targetName: string,
  config: WorkConfig,
  opts: { pull?: boolean; jiraKey?: string; name?: string } = {},
): Promise<BaseCheckoutResult> {
  const target = resolveProjectTarget(targetName, config);
  if (!target) return { ok: false, error: `Project or group not found: ${targetName}` };
  if (target.isGroup) return { ok: false, error: `${targetName} is a group: give it a branch (a group has no one checkout to open)` };
  const repoPath = config.repos[targetName];
  if (!repoPath) return { ok: false, error: `Repository path not configured for: ${targetName}` };
  if (!fs.existsSync(repoPath)) return { ok: false, error: `Repository path does not exist: ${repoPath}` };
  const branch = getCurrentBranch(repoPath) ?? '(detached)';
  // Detached HEAD has no upstream to pull from — skip rather than warn.
  if (opts.pull !== false && branch && branch !== '(detached)') pullLatestForBranch(repoPath, branch);
  await upsertSession(targetName, false, branch, [repoPath], opts.jiraKey);
  if (opts.name?.trim()) await setSessionTitle(targetName, branch, opts.name);
  const dropped = await forgetOtherBaseCheckoutEntries(targetName, branch, repoPath);
  return { ok: true, repoPath, branch, dropped };
}
