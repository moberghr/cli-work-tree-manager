import fs from 'node:fs';
import path from 'node:path';
import { agentFor } from '../agents/index.js';
import { migrateScope, type ScopeMigration } from '../diff/scope-migrate.js';
import { git, localBranchExists, remoteBranchExists } from '../git/git.js';
import { loadConfig, type WorkConfig } from '../platform/config.js';
import { collectingReporter, report, withReporter } from '../platform/report.js';
import { appendSessionRepo, findSessionById } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { addRepoRefusal } from './add-repo-rules.js';
import { writeSessionInstructions } from './session-instructions.js';
import { createSingleWorktree, removeSingleWorktree } from './worktree.js';

export { addedRepoNote, addRepoRefusal, type AddRepoRefusal } from './add-repo-rules.js';

/**
 * Add a repo to a session folder (a group session, or one made with config
 * `sessionFolders`): the repo is checked out into the folder on the
 * session's branch — its existing branch as it is, else a new one from the
 * base given, else from the repo's own checkout's branch (as `work tree`
 * makes one) —, recorded on the session, the Diff tab's turn history moved
 * to the session's new scope (scope-migrate.ts), and the folder's
 * instructions file given its import. The session's Claude already sees the
 * folder: nothing restarts. Every refusal changes nothing; a checkout that
 * can't be recorded is removed again. What went wrong after the repo was in
 * (the turns, the instructions file) is in `warnings`: the add stands.
 */

/** A refusal (addRepoRefusal), with the HTTP status that says it; any other failure is a plain Error. */
export class AddRepoRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface AddRepoResult {
  alias: string;
  /** The new checkout: `<session folder>/<repo folder>`. */
  path: string;
  branch: string;
  /** The branch was made for it (false: its existing branch was checked out). */
  created: boolean;
  /** The branch a new one was made from. */
  from?: string;
  /** The folder's instructions file imports the repo's own now. */
  imported: boolean;
  /** What didn't go as it should after the repo was in (said, and kept). */
  warnings: string[];
}

type CheckoutOutcome = { ok: true; created: boolean; from?: string; warnings: string[] } | { ok: false; error: string };

export interface AddRepoDeps {
  config: () => WorkConfig | null;
  session: (id: string) => WorktreeSession | null;
  /** Check the repo out at `worktree` on `branch`; a new branch from `base` (else the repo's own checkout's branch). */
  checkout: (repoPath: string, worktree: string, branch: string, config: WorkConfig, base: string | undefined) => CheckoutOutcome;
  /** Undo a checkout that couldn't be recorded: its worktree, and its branch when it was made for it. */
  undoCheckout: (repoPath: string, worktree: string, branch: string, created: boolean) => boolean;
  record: typeof appendSessionRepo;
  migrate: (oldPaths: string[], newPaths: string[]) => Promise<ScopeMigration>;
  instructions: (s: WorktreeSession, folder: string, config: WorkConfig) => { file: string; imported: string[] | null };
}

/** The real checkout: createSingleWorktree, with its reports kept so a failure says why. */
export function checkoutIntoSession(
  repoPath: string,
  worktree: string,
  branch: string,
  config: WorkConfig,
  base: string | undefined,
): CheckoutOutcome {
  const reports = collectingReporter();
  const warnings: string[] = [];
  const out = withReporter(reports, () => {
    // Fetched, so a branch only on origin is found; one that fails is said, and createSingleWorktree tries itself.
    const fetched = git(['fetch', '--quiet'], repoPath);
    if (fetched.exitCode !== 0) warnings.push(`couldn't fetch ${path.basename(repoPath)}: ${fetched.stderr || 'git fetch failed'}`);
    // Its own branch of this name, when it has one, is checked out as it is (a base is for a new branch only).
    const exists = localBranchExists(branch, repoPath) || remoteBranchExists(branch, repoPath);
    const created: { from?: string } = {};
    const useBase = exists ? undefined : base;
    if (exists && base) warnings.push(`${branch} exists already in this repo: checked out as it is (not from ${base})`);
    const ok = createSingleWorktree(repoPath, worktree, branch, config, useBase, false, fetched.exitCode === 0, created);
    if (!ok) return null;
    const from = exists ? undefined : (useBase ?? created.from);
    return { ok: true as const, created: !exists, ...(from ? { from } : {}), warnings };
  });
  // What it said: its warnings into the answer (work web's child answers with one JSON line,
  // so a report alone would reach no one), the rest to whoever called; its errors are the failure's reason.
  for (const e of reports.entries) {
    if (e.level === 'warn' && e.text.trim()) warnings.push(e.text.trim());
    else if (e.level !== 'error') report(e.level, e.text);
  }
  if (out) return out;
  // Failed: what it warned about on the way is said too (the error is the answer).
  for (const w of warnings) report('warn', `  ${w}`);
  const why = reports
    .errors()
    .map((e) => e.trim())
    .filter(Boolean)
    .join(' ');
  return { ok: false, error: why || 'git could not check it out' };
}

/** Remove a checkout that couldn't be recorded, and the branch made for it (nothing is on it yet). */
function undoCheckout(repoPath: string, worktree: string, branch: string, created: boolean): boolean {
  const removed = removeSingleWorktree(repoPath, worktree, branch, true);
  if (removed && created) git(['branch', '-D', branch], repoPath);
  return removed && !fs.existsSync(worktree);
}

/**
 * The folder's instructions file gets the new repo's import: work's block
 * lists every repo of the session (as re-entering the session writes it). A
 * group's copied summary (from before) is kept as it is, the block after it.
 * `imported` null: its agent can't import (its file left as it is).
 */
function updateInstructions(s: WorktreeSession, folder: string, config: WorkConfig): { file: string; imported: string[] | null } {
  const agent = agentFor(config, s);
  if (!agent.instructionsImport) return { file: agent.instructionsFile, imported: null };
  const imported = writeSessionInstructions(
    folder,
    s.paths.map((p) => path.basename(p)),
    agent.instructionsFile,
    agent.instructionsImport,
  );
  return { file: agent.instructionsFile, imported };
}

export const defaultAddRepoDeps: AddRepoDeps = {
  config: loadConfig,
  session: findSessionById,
  checkout: checkoutIntoSession,
  undoCheckout,
  record: appendSessionRepo,
  migrate: migrateScope,
  instructions: updateInstructions,
};

export async function addRepoToSession(
  sessionId: string,
  alias: string,
  opts: { base?: string } = {},
  deps: Partial<AddRepoDeps> = {},
): Promise<AddRepoResult> {
  const d = { ...defaultAddRepoDeps, ...deps };
  const config = d.config();
  if (!config) throw new Error('no config: run `work init` first');
  const base = opts.base?.trim() || undefined;
  const s = d.session(sessionId);
  const refusal = addRepoRefusal(s, alias, config, (p) => fs.existsSync(p), base);
  if (refusal || !s) throw new AddRepoRefused(refusal?.error ?? 'unknown session', refusal?.status ?? 404);

  const repoPath = config.repos[alias];
  const folder = path.dirname(s.paths[0]);
  const repoFolder = path.basename(repoPath);
  const worktree = path.join(folder, repoFolder);
  report('step', `[${alias}] (${repoFolder}) into ${folder}:`);
  const made = d.checkout(repoPath, worktree, s.branch, config, base);
  if (!made.ok) throw new Error(made.error);
  const warnings = [...made.warnings];

  // Recorded on the session as it is now (its paths before: the scope its turns move from).
  let recorded: ReturnType<typeof appendSessionRepo>;
  try {
    recorded = d.record(sessionIdFor(s), alias, worktree, made.from, config, !!agentFor(config, s).instructionsImport);
    if (!recorded) throw new Error('the session is gone');
  } catch (err) {
    // Never a checkout no session knows of: a retry would find its folder and refuse.
    const undone = d.undoCheckout(repoPath, worktree, s.branch, made.created);
    throw new Error(
      `couldn't record ${alias} on the session (${(err as Error).message})` +
        (undone ? '; its checkout was removed again' : `; its checkout is still at ${worktree}: remove it by hand before trying again`),
      { cause: err },
    );
  }

  // The turn history follows the session to its new scope; a failure here loses none of the checkout.
  try {
    const moved = await d.migrate(recorded.before, recorded.session.paths);
    for (const p of moved.problems) warnings.push(`the Diff tab's turns: ${p}`);
  } catch (err) {
    warnings.push(`couldn't carry the Diff tab's turns over: ${(err as Error).message}`);
  }
  let imported = false;
  try {
    const r = d.instructions(recorded.session, folder, config);
    if (r.imported === null) warnings.push(`its agent can't import files into ${r.file}: the session folder's file is left as it is`);
    else {
      imported = r.imported.includes(repoFolder);
      report('success', `  ${r.file} in the session folder imports ${r.imported.length} repo file(s)`);
    }
  } catch (err) {
    warnings.push(`couldn't update the session folder's instructions file: ${(err as Error).message}`);
  }
  return { alias, path: worktree, branch: s.branch, created: made.created, ...(made.from ? { from: made.from } : {}), imported, warnings };
}
