import path from 'node:path';
import crossSpawn from '../platform/spawn.js';
import type { BaseSpec } from '../git/base-spec.js';
import type { WorkConfig } from '../platform/config.js';
import { findSession, loadHistory } from '../sessions/history.js';
import { openBaseCheckout, setupWorktree } from './worktree.js';
import { collectingReporter, withReporter } from '../platform/report.js';
import { resolveProjectTarget } from './resolve.js';
import { defaultRunner } from '../pr/ship.js';
import { sessionAliases } from '../sessions/session-repos.js';

/**
 * Creating a worktree runs git synchronously (fetch, pull, worktree add):
 * done inside work web, that held up every request — the dashboard, the
 * terminals' relays, the status hooks — for as long as the network took.
 * So work web runs it as `work tree … --setup-only` in a child process and
 * reads the result back from the history it wrote. The CLI and tests use
 * the in-process `createInProcess`; both answer the same way.
 */

export interface CreateRequest {
  target: string;
  /** Empty: the repo's own checkout, on the branch it has (`work tree <repo>`). */
  branch?: string;
  base?: BaseSpec;
  jiraKey?: string;
  name?: string;
  /** A new session's repos instead of its group's config (a fork of a session folder: the parent's own). */
  repos?: string[];
}

export type CreateResult = { ok: true; branch: string; launchDir: string; paths: string[] } | { ok: false; error: string };
export type CreateWorktree = (req: CreateRequest, config: WorkConfig) => Promise<CreateResult>;

/**
 * A request the child's command line could misread: a project or branch
 * starting with `-` would be taken for a flag (`--unsafe` as a branch opened
 * the base checkout instead). Git refuses such branch names anyway. Pure.
 */
export function invalidRequest(req: CreateRequest): string | null {
  if (req.target.startsWith('-')) return `not a project: ${req.target}`;
  if (req.branch?.startsWith('-')) return `${req.branch} is not a valid branch name (it can't start with "-")`;
  for (const [alias, b] of Object.entries(req.base?.perRepo ?? {}))
    if (alias.startsWith('-') || b.startsWith('-')) return `not a valid base: ${alias}=${b}`;
  if (req.base?.default?.startsWith('-')) return `not a valid base: ${req.base.default}`;
  for (const alias of req.repos ?? []) if (!alias || alias.startsWith('-') || alias.includes(',')) return `not a repo: ${alias}`;
  return null;
}

/** `--base` flags for a base spec (`--base=dev`, `--base=backend=dev`). Pure. */
export function baseArgs(spec: BaseSpec | undefined): string[] {
  if (!spec) return [];
  const out: string[] = [];
  if (spec.default) out.push(`--base=${spec.default}`);
  for (const [alias, b] of Object.entries(spec.perRepo)) out.push(`--base=${alias}=${b}`);
  return out;
}

/**
 * The argv of the child `work tree` run (after node and the bin). Values go
 * as `--flag=value`: a name like `--unsafe` given as `--name --unsafe` would
 * be read as a flag of its own (and the name lost). Pure.
 */
export function childArgs(req: CreateRequest): string[] {
  return [
    'tree',
    req.target,
    ...(req.branch ? [req.branch] : []),
    '--setup-only',
    ...baseArgs(req.base),
    ...(req.jiraKey ? [`--jira-key=${req.jiraKey}`] : []),
    ...(req.name?.trim() ? [`--name=${req.name.trim()}`] : []),
    ...(req.repos?.length ? [`--repos=${req.repos.join(',')}`] : []),
  ];
}

/**
 * One creation at a time per project: they fetch, pull and add worktrees in
 * the same repos (git's own locks would turn two at once into a failure),
 * and a double-clicked create of the same branch gets the first one's answer.
 */
export function oneAtATime(create: CreateWorktree, queue: KeyedQueue = keyedQueue()): CreateWorktree {
  const same = new Map<string, Promise<CreateResult>>();
  return (req, config) => {
    const key = `${req.target}\0${req.branch ?? ''}`;
    const running = same.get(key);
    if (running) return running;
    const job = queue(req.target, () => create(req, config));
    same.set(key, job);
    void job
      .catch(() => undefined)
      .then(() => {
        if (same.get(key) === job) same.delete(key);
      });
    return job;
  };
}

/** Runs jobs one after another per key (a project, or a repo), any number of keys at once. */
export type KeyedQueue = <T>(key: string, job: () => Promise<T>) => Promise<T>;

export function keyedQueue(): KeyedQueue {
  const queues = new Map<string, Promise<unknown>>();
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const before = queues.get(key) ?? Promise.resolve();
    const run = before.then(job);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  };
}

/** What a child `work` run gave back. */
export interface ChildRun {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Killed after its time ran out. */
  timedOut: boolean;
  /** It couldn't be started at all. */
  spawnError?: string;
}

/**
 * Run `node <work> <args…>` in a child process (no window, no colours),
 * killed after `timeoutMs` (5 min). This process's node flags go with it:
 * under tsx (dev) they are what loads a .ts entry (but not a debugger's,
 * whose port is taken).
 */
export function runWorkChild(
  workBin: string,
  args: string[],
  opts: { node?: string; execArgv?: string[]; timeoutMs?: number } = {},
): Promise<ChildRun> {
  return new Promise((resolve) => {
    const child = crossSpawn(
      opts.node ?? process.execPath,
      [...(opts.execArgv ?? process.execArgv).filter((f) => !/^--inspect/.test(f)), workBin, ...args],
      { windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      opts.timeoutMs ?? 5 * 60_000,
    );
    let settled = false;
    const done = (r: ChildRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on('error', (err) => done({ stdout, stderr, code: null, timedOut, spawnError: err.message }));
    child.on('close', (code) => done({ stdout, stderr, code, timedOut }));
  });
}

/** What a child printed, in one line, its colours stripped. Pure. */
export function childText(text: string): string {
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

const ANSI = /\x1b\[[0-9;]*m/g;

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/** What the run left in the history: the session it created or opened. */
function resultFromHistory(req: CreateRequest, config: WorkConfig): CreateResult {
  const history = loadHistory();
  if (req.branch) {
    const s = findSession(history, req.target, req.branch);
    if (!s) return { ok: false, error: 'the worktree was set up, but its session is not in the history' };
    return { ok: true, branch: s.branch, launchDir: s.isGroup && s.paths[0] ? path.dirname(s.paths[0]) : s.paths[0], paths: s.paths };
  }
  const repo = config.repos[req.target];
  const s = repo
    ? history
        .filter((x) => !x.archivedAt && x.target === req.target && x.paths.some((p) => norm(p) === norm(repo)))
        .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))[0]
    : undefined;
  if (!s) return { ok: false, error: `opened ${req.target}, but its session is not in the history` };
  return { ok: true, branch: s.branch, launchDir: repo, paths: [repo] };
}

/** Out of process (work web): `node <work> tree … --setup-only`, then the history. */
export function createInChild(workBin: string, opts: { node?: string; execArgv?: string[]; timeoutMs?: number } = {}): CreateWorktree {
  return async (req, config) => {
    const invalid = invalidRequest(req);
    if (invalid) return { ok: false, error: invalid };
    const r = await runWorkChild(workBin, childArgs(req), opts);
    if (r.spawnError) return { ok: false, error: `could not run work: ${r.spawnError}` };
    if (r.timedOut) {
      // Killed from outside, its own rollback never ran: drop what a
      // half-made `git worktree add` registered, so a retry can make it.
      await pruneWorktrees(req.target, req.branch, config);
      return { ok: false, error: 'setting it up took too long (stopped; run it again, or `work tree` it from a terminal to see why)' };
    }
    if (r.code === 0) return resultFromHistory(req, config);
    // Its errors, as the CLI printed them (the reporter sends errors to stderr).
    const why = childText(r.stderr || r.stdout);
    return { ok: false, error: why || (r.code === null ? 'setting it up took too long' : `work tree exited ${r.code}`) };
  };
}

/**
 * `git worktree prune` in each repo of the session (best effort): its own
 * repos when it has a row (sessionAliases: one added to it, or a fork's list),
 * else the project's.
 */
export async function pruneWorktrees(target: string, branch: string | undefined, config: WorkConfig): Promise<void> {
  const known = branch ? findSession(loadHistory(), target, branch) : undefined;
  const aliases = known ? sessionAliases(known, config) : (resolveProjectTarget(target, config)?.repoAliases ?? []);
  for (const alias of aliases) {
    const repo = config.repos[alias];
    if (repo) await defaultRunner('git', ['-C', repo, 'worktree', 'prune'], repo).catch(() => undefined);
  }
}

/** In process (the CLI, tests): the same core calls `work tree` makes. */
export const createInProcess: CreateWorktree = async (req, config) => {
  const invalid = invalidRequest(req);
  if (invalid) return { ok: false, error: invalid };
  if (!req.branch) {
    const opened = await openBaseCheckout(req.target, config, { jiraKey: req.jiraKey, name: req.name });
    return opened.ok
      ? { ok: true, branch: opened.branch, launchDir: opened.repoPath, paths: [opened.repoPath] }
      : { ok: false, error: opened.error };
  }
  // Keep what core reports, so a failure says why.
  const reports = collectingReporter();
  const created = await withReporter(reports, () =>
    setupWorktree(req.target, req.branch!, config, req.base, req.jiraKey, {
      name: req.name,
      ...(req.repos?.length ? { repos: req.repos } : {}),
    }),
  );
  if (!created)
    return {
      ok: false,
      error:
        reports
          .errors()
          .map((e) => e.trim())
          .join(' ') || 'setup failed (target not found?)',
    };
  return { ok: true, branch: req.branch, launchDir: created.launchDir, paths: created.paths };
};
