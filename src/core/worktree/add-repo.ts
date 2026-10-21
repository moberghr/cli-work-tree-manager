import fs from 'node:fs';
import path from 'node:path';
import { agentFor } from '../agents/index.js';
import { migrateScope } from '../diff/scope-migrate.js';
import { git, localBranchExists, remoteBranchExists } from '../git/git.js';
import { loadConfig, type WorkConfig } from '../platform/config.js';
import { collectingReporter, report, withReporter } from '../platform/report.js';
import { appendSessionRepo, findSessionById } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { sessionRepos } from '../sessions/session-repos.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { writeSessionInstructions } from './session-instructions.js';
import { createSingleWorktree } from './worktree.js';

/**
 * Add a repo to a session folder (a group session, or one made with config
 * `sessionFolders`): the repo is checked out into the folder on the
 * session's branch — its existing branch as it is, else a new one from the
 * base given, else from the repo's own checkout's branch (as `work tree`
 * makes one) —, recorded on the session, the Diff tab's turn history moved
 * to the session's new scope (scope-migrate.ts), and the folder's
 * instructions file given its import. The session's Claude already sees the
 * folder: nothing restarts. Every refusal changes nothing.
 */

export interface AddRepoResult {
  alias: string;
  /** The new checkout: `<session folder>/<repo folder>`. */
  path: string;
  branch: string;
  /** The branch was made for it (false: its existing branch was checked out). */
  created: boolean;
  /** The branch a new one was made from. */
  from?: string;
}

export interface AddRepoDeps {
  config: () => WorkConfig | null;
  session: (id: string) => WorktreeSession | null;
  /** Check the repo out at `worktree` on `branch`; a new branch from `base` (else the repo's own checkout's branch). */
  checkout: (
    repoPath: string,
    worktree: string,
    branch: string,
    config: WorkConfig,
    base: string | undefined,
  ) => { ok: true; created: boolean; from?: string } | { ok: false; error: string };
  migrate: (oldPaths: string[], newPaths: string[]) => unknown;
}

const sameFolder = (a: string, b: string) => path.basename(a).toLowerCase() === path.basename(b).toLowerCase();

/** Why a repo can't be added, and the HTTP status that says it (404 no session, 400 a bad request, 409 not now / not here). */
export interface AddRepoRefusal {
  status: 400 | 404 | 409;
  error: string;
}

/**
 * Why this repo can't be added to this session, or null. Pure apart from the
 * one look at the disk (`exists`): a folder of that name in the session folder.
 */
export function addRepoRefusal(
  s: WorktreeSession | null,
  alias: string,
  config: Pick<WorkConfig, 'repos' | 'groups'>,
  exists: (p: string) => boolean,
  base?: string,
): AddRepoRefusal | null {
  if (!s) return { status: 404, error: 'unknown session' };
  if (!alias || alias.startsWith('-') || base?.startsWith('-'))
    return { status: 400, error: `not a valid repo or base: ${alias}${base ? ` ${base}` : ''}` };
  if (s.archivedAt) return { status: 409, error: 'it is archived: restore it first' };
  if (!s.isGroup || s.paths.length === 0)
    return {
      status: 409,
      error: `${s.target} · ${s.branch} is a single repo's worktree, not a session folder: a repo can only be added to a session made as a folder (a group's, or a new session with config \`sessionFolders: true\`)`,
    };
  const repoPath = config.repos[alias];
  if (!repoPath) return { status: 400, error: `no repo called ${alias} in your config` };
  if (sessionRepos(s, config).some((r) => r.alias === alias)) return { status: 409, error: `${alias} is in this session already` };
  const folder = path.basename(repoPath);
  if (s.paths.some((p) => sameFolder(p, folder))) return { status: 409, error: `this session already has a folder called ${folder}` };
  if (exists(path.join(path.dirname(s.paths[0]), folder)))
    return { status: 409, error: `${folder} already exists in the session folder: move it away first` };
  return null;
}

/** The real checkout: createSingleWorktree, with its reports kept so a failure says why. */
export function checkoutIntoSession(
  repoPath: string,
  worktree: string,
  branch: string,
  config: WorkConfig,
  base: string | undefined,
): { ok: true; created: boolean; from?: string } | { ok: false; error: string } {
  const reports = collectingReporter();
  const out = withReporter(reports, () => {
    git(['fetch', '--quiet'], repoPath);
    // Its own branch of this name, when it has one, is checked out as it is (a base is for a new branch only).
    const exists = localBranchExists(branch, repoPath) || remoteBranchExists(branch, repoPath);
    const created: { from?: string } = {};
    const useBase = exists ? undefined : base;
    if (exists && base) report('warn', `  ${branch} exists already in this repo: checked out as it is (not from ${base})`);
    const ok = createSingleWorktree(repoPath, worktree, branch, config, useBase, false, true, created);
    if (!ok) return null;
    const from = exists ? undefined : (useBase ?? created.from);
    return { ok: true as const, created: !exists, ...(from ? { from } : {}) };
  });
  // What it said, to whoever called (the CLI prints it); its errors go in the answer instead.
  for (const e of reports.entries) if (e.level !== 'error') report(e.level, e.text);
  if (out) return out;
  const why = reports
    .errors()
    .map((e) => e.trim())
    .filter(Boolean)
    .join(' ');
  return { ok: false, error: why || 'git could not check it out' };
}

/** Record the new checkout on the session (history.ts owns the row). */
function recordRepo(id: string, alias: string, worktree: string, from: string | undefined, config: WorkConfig): WorktreeSession {
  const s = appendSessionRepo(id, alias, worktree, from, config);
  if (!s) throw new Error('the session is gone');
  return s;
}

/**
 * The folder's instructions file gets the new repo's import: work's block
 * lists every repo of the session (as re-entering the session writes it). A
 * group's copied summary (from before) is kept as it is, the block after it.
 */
function updateInstructions(s: WorktreeSession, folder: string, config: WorkConfig): string[] {
  return writeSessionInstructions(
    folder,
    s.paths.map((p) => path.basename(p)),
    agentFor(config, s).instructionsFile,
  );
}

export const defaultAddRepoDeps: AddRepoDeps = {
  config: loadConfig,
  session: findSessionById,
  checkout: checkoutIntoSession,
  migrate: migrateScope,
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
  if (refusal || !s) throw new Error(refusal?.error ?? 'unknown session');

  const repoPath = config.repos[alias];
  const folder = path.dirname(s.paths[0]);
  const repoFolder = path.basename(repoPath);
  const worktree = path.join(folder, repoFolder);
  report('step', `[${alias}] (${repoFolder}) into ${folder}:`);
  const made = d.checkout(repoPath, worktree, s.branch, config, base);
  if (!made.ok) throw new Error(made.error);

  const id = sessionIdFor(s);
  const oldPaths = [...s.paths];
  const recorded = recordRepo(id, alias, worktree, made.from, config);
  // The turn history follows the session to its new scope; a failure here loses none of the checkout.
  try {
    d.migrate(oldPaths, recorded.paths);
  } catch (err) {
    report('warn', `  couldn't carry the Diff tab's turns over: ${(err as Error).message}`);
  }
  try {
    const imports = updateInstructions(recorded, folder, config);
    report('success', `  ${agentFor(config, recorded).instructionsFile} in the session folder imports ${imports.length} repo file(s)`);
  } catch (err) {
    report('warn', `  couldn't update the session folder's instructions file: ${(err as Error).message}`);
  }
  return { alias, path: worktree, branch: s.branch, created: made.created, ...(made.from ? { from: made.from } : {}) };
}

/** The note the session's Claude gets once a repo was added (a published general comment). Pure. */
export function addedRepoNote(r: Pick<AddRepoResult, 'alias' | 'path' | 'branch' | 'from'>, instructionsFile = 'CLAUDE.md'): string {
  const folder = path.basename(r.path);
  return (
    `Added repo ${r.alias} to this session: ./${folder} on branch ${r.branch}${r.from ? `, made from ${r.from}` : ''}. ` +
    `Its ${instructionsFile} is imported by the session's instructions file.`
  );
}
