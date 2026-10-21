import fs from 'node:fs';
import path from 'node:path';
import type { AddRepoWire } from '../api-types.js';
import { loadConfig } from '../platform/config.js';
import { defaultRunner } from '../pr/ship.js';
import { findSessionById } from '../sessions/history.js';
import { sessionRepos } from '../sessions/session-repos.js';
import { childText, runWorkChild } from './setup-child.js';

/**
 * Adding a repo runs git synchronously (fetch, worktree add), so work web
 * runs it as `work add-repo … --in-process --json` in a child process, like
 * creating a worktree (setup-child.ts), and reads its answer: one JSON line.
 */

export type AddRepoOutcome = { ok: true; wire: AddRepoWire } | { ok: false; error: string; status: 400 | 404 | 409 | 500 };

/** Runs the add (in a child process, in work web). */
export type AddRepoRunner = (sessionId: string, alias: string, base: string | undefined) => Promise<AddRepoOutcome>;

const statusOf = (v: unknown): 400 | 404 | 409 | 500 => (v === 400 || v === 404 || v === 409 ? v : 500);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The child's answer: its last JSON line on stdout ({ok…} or {error, status}), else what it printed on stderr. Pure. */
export function parseChildOutcome(stdout: string, stderr: string, code: number | null): AddRepoOutcome {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]) as Partial<AddRepoWire> & { error?: unknown; status?: unknown };
      if (typeof v.error === 'string') return { ok: false, error: v.error, status: statusOf(v.status) };
      if (v.ok === true && typeof v.path === 'string' && typeof v.branch === 'string' && typeof v.created === 'boolean')
        return {
          ok: true,
          wire: {
            ok: true,
            path: v.path,
            branch: v.branch,
            created: v.created,
            ...(typeof v.from === 'string' ? { from: v.from } : {}),
            imported: v.imported === true,
            warnings: strings(v.warnings),
          },
        };
    } catch {
      /* not the answer */
    }
  }
  return { ok: false, error: childText(stderr) || `work add-repo exited ${code ?? '(killed)'}`, status: 500 };
}

/** `node <work> add-repo <alias> --session-id=<id> --in-process --json [--base=…]` (values as `--flag=value`). Pure. */
export function addRepoChildArgs(sessionId: string, alias: string, base: string | undefined): string[] {
  return ['add-repo', alias, `--session-id=${sessionId}`, '--in-process', '--json', ...(base ? [`--base=${base}`] : [])];
}

/**
 * After a child killed for taking too long: what it left, in words. Recorded
 * on the session: added (its last steps may not have run). Else a checkout
 * may be in the session folder that no session knows of: named, so it can be
 * removed before trying again.
 */
export function afterTimeout(sessionId: string, alias: string): string {
  const config = loadConfig();
  const s = findSessionById(sessionId);
  const repo = config?.repos[alias];
  if (!config || !s || !repo) return 'checking it out took too long (stopped)';
  if (sessionRepos(s, config).some((r) => r.alias === alias))
    return `checking it out took too long (stopped): ${alias} is in the session, but its Diff tab turns or instructions may not have been updated`;
  const left = s.paths[0] ? path.join(path.dirname(s.paths[0]), path.basename(repo)) : '';
  return left && fs.existsSync(left)
    ? `checking it out took too long (stopped): ${left} was left half made — remove it, then try again`
    : 'checking it out took too long (stopped; run `work add-repo` from a terminal to see why)';
}

/** The real runner: a child `work add-repo`, killed after `timeoutMs` (what git left half-made is pruned, and said). */
export function addRepoInChild(workBin: () => string, opts: { timeoutMs?: number; execArgv?: string[] } = {}): AddRepoRunner {
  return async (sessionId, alias, base) => {
    const r = await runWorkChild(workBin(), addRepoChildArgs(sessionId, alias, base), opts);
    if (r.spawnError) return { ok: false, error: `could not run work: ${r.spawnError}`, status: 500 };
    if (!r.timedOut) return parseChildOutcome(r.stdout, r.stderr, r.code);
    const repo = loadConfig()?.repos[alias];
    if (repo && fs.existsSync(repo)) await defaultRunner('git', ['-C', repo, 'worktree', 'prune'], repo).catch(() => undefined);
    return { ok: false, error: afterTimeout(sessionId, alias), status: 500 };
  };
}
