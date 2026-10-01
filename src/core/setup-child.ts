import path from 'node:path';
import crossSpawn from 'cross-spawn';
import type { BaseSpec } from './base-spec.js';
import type { WorkConfig } from './config.js';
import { findSession, loadHistory } from './history.js';
import { openBaseCheckout, setupWorktree } from './worktree.js';
import { collectingReporter, withReporter } from './report.js';

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
}

export type CreateResult = { ok: true; branch: string; launchDir: string; paths: string[] } | { ok: false; error: string };
export type CreateWorktree = (req: CreateRequest, config: WorkConfig) => Promise<CreateResult>;

/** `--base` flags for a base spec (`--base dev`, `--base backend=dev`). Pure. */
export function baseArgs(spec: BaseSpec | undefined): string[] {
  if (!spec) return [];
  const out: string[] = [];
  if (spec.default) out.push('--base', spec.default);
  for (const [alias, b] of Object.entries(spec.perRepo)) out.push('--base', `${alias}=${b}`);
  return out;
}

/** The argv of the child `work tree` run (after node and the bin). Pure. */
export function childArgs(req: CreateRequest): string[] {
  return [
    'tree',
    req.target,
    ...(req.branch ? [req.branch] : []),
    '--setup-only',
    ...baseArgs(req.base),
    ...(req.jiraKey ? ['--jira-key', req.jiraKey] : []),
    ...(req.name?.trim() ? ['--name', req.name.trim()] : []),
  ];
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
  const s = repo ? history.filter((x) => !x.archivedAt && x.target === req.target && x.paths.some((p) => norm(p) === norm(repo))).sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt))[0] : undefined;
  if (!s) return { ok: false, error: `opened ${req.target}, but its session is not in the history` };
  return { ok: true, branch: s.branch, launchDir: repo, paths: [repo] };
}

/** Out of process (work web): `node <work> tree … --setup-only`, then the history. */
export function createInChild(workBin: string, opts: { node?: string; execArgv?: string[]; timeoutMs?: number } = {}): CreateWorktree {
  return (req, config) =>
    new Promise((resolve) => {
      // This process's node flags too: under tsx (dev) they are what loads a .ts entry
      // (but not a debugger's, whose port is taken).
      const child = crossSpawn(opts.node ?? process.execPath, [...(opts.execArgv ?? process.execArgv).filter((f) => !/^--inspect/.test(f)), workBin, ...childArgs(req)], {
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 5 * 60_000);
      let settled = false;
      const done = (r: CreateResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      child.on('error', (err) => done({ ok: false, error: `could not run work: ${err.message}` }));
      child.on('close', (code) => {
        if (code === 0) return done(resultFromHistory(req, config));
        // Its errors, as the CLI printed them (the reporter sends errors to stderr).
        const why = (stderr || stdout).replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
        done({ ok: false, error: why || (code === null ? 'setting it up took too long' : `work tree exited ${code}`) });
      });
    });
}

/** In process (the CLI, tests): the same core calls `work tree` makes. */
export const createInProcess: CreateWorktree = async (req, config) => {
  if (!req.branch) {
    const opened = await openBaseCheckout(req.target, config, { jiraKey: req.jiraKey, name: req.name });
    return opened.ok ? { ok: true, branch: opened.branch, launchDir: opened.repoPath, paths: [opened.repoPath] } : { ok: false, error: opened.error };
  }
  // Keep what core reports, so a failure says why.
  const reports = collectingReporter();
  const created = await withReporter(reports, () => setupWorktree(req.target, req.branch!, config, req.base, req.jiraKey, { name: req.name }));
  if (!created) return { ok: false, error: reports.errors().map((e) => e.trim()).join(' ') || 'setup failed (target not found?)' };
  return { ok: true, branch: req.branch, launchDir: created.launchDir, paths: created.paths };
};
