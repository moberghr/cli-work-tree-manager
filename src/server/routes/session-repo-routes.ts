import fs from 'node:fs';
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AddRepoWire } from '../../core/api-types.js';
import { agentFor } from '../../core/agents/index.js';
import { loadConfig } from '../../core/platform/config.js';
import crossSpawn from '../../core/platform/spawn.js';
import { findSessionById } from '../../core/sessions/history.js';
import { addedRepoNote, addRepoRefusal } from '../../core/worktree/add-repo.js';
import { defaultRunner } from '../../core/pr/ship.js';
import { report } from '../../core/platform/report.js';

/**
 * POST /api/sessions/:id/repos  {alias, base?} — add a repo to a session
 * folder (add-repo.ts). Checking it out runs git synchronously (fetch,
 * worktree add), so it runs in a child process, `work add-repo … --in-process`,
 * like creating a worktree (setup-child.ts). One add per session at a time.
 * Before it, the session's diff scope is released here (the child moves its
 * turn history to the new scope, and nothing may write the old one meanwhile);
 * after it, the session's Claude is told by a published note.
 */

export type AddRepoOutcome = { ok: true; wire: AddRepoWire } | { ok: false; error: string };

/** Runs the add (in a child process, in work web). */
export type AddRepoRunner = (sessionId: string, alias: string, base: string | undefined) => Promise<AddRepoOutcome>;

export interface SessionRepoRouteOptions {
  broadcast: (event: string, data: unknown) => void;
  run: AddRepoRunner;
  /** Let go of the session's scope (and watcher) before its paths change. */
  release: (sessionId: string, paths: string[]) => Promise<void> | void;
  /** Drop what is cached per session (diff stats, behind main). */
  invalidate: (sessionId: string) => void;
  /** Tell the session's Claude (a published general comment). */
  note: (sessionId: string, body: string) => Promise<void>;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** The child's answer: its last JSON line on stdout ({ok…} or {error}), else what it printed on stderr. Pure. */
export function parseChildOutcome(stdout: string, stderr: string, code: number | null): AddRepoOutcome {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]) as Partial<AddRepoWire> & { error?: unknown };
      if (typeof v.error === 'string') return { ok: false, error: v.error };
      if (v.ok === true && typeof v.path === 'string' && typeof v.branch === 'string' && typeof v.created === 'boolean')
        return {
          ok: true,
          wire: { ok: true, path: v.path, branch: v.branch, created: v.created, ...(typeof v.from === 'string' ? { from: v.from } : {}) },
        };
    } catch {
      /* not the answer */
    }
  }
  const why = stderr
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  return { ok: false, error: why || `work add-repo exited ${code ?? '(killed)'}` };
}

/** `node <work> add-repo <alias> --session-id=<id> --in-process --json [--base=…]` (values as `--flag=value`). Pure. */
export function addRepoChildArgs(sessionId: string, alias: string, base: string | undefined): string[] {
  return ['add-repo', alias, `--session-id=${sessionId}`, '--in-process', '--json', ...(base ? [`--base=${base}`] : [])];
}

/** The real runner: a child `work add-repo`, killed after `timeoutMs` (what git left half-made is pruned). */
export function addRepoInChild(workBin: () => string, opts: { timeoutMs?: number; execArgv?: string[] } = {}): AddRepoRunner {
  return (sessionId, alias, base) =>
    new Promise((resolve) => {
      // This process's node flags too: under tsx (dev) they are what loads a .ts entry (not a debugger's, whose port is taken).
      const child = crossSpawn(
        process.execPath,
        [
          ...(opts.execArgv ?? process.execArgv).filter((f) => !/^--inspect/.test(f)),
          workBin(),
          ...addRepoChildArgs(sessionId, alias, base),
        ],
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
      const done = (r: AddRepoOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      child.on('error', (err) => done({ ok: false, error: `could not run work: ${err.message}` }));
      child.on('close', (code) => {
        if (!timedOut) return done(parseChildOutcome(stdout, stderr, code));
        const repo = loadConfig()?.repos[alias];
        const prune = repo && fs.existsSync(repo) ? defaultRunner('git', ['-C', repo, 'worktree', 'prune'], repo) : Promise.resolve();
        void prune
          .catch(() => undefined)
          .finally(() =>
            done({ ok: false, error: 'checking it out took too long (stopped; run `work add-repo` from a terminal to see why)' }),
          );
      });
    });
}

export function mountSessionRepoRoutes(app: Hono, opts: SessionRepoRouteOptions): void {
  const schema = z.object({ alias: z.string().min(1).max(200), base: z.string().max(200).optional() });
  const running = new Set<string>();

  app.post('/api/sessions/:id/repos', zValidator('json', schema), async (c) => {
    const id = c.req.param('id');
    const { alias, base: rawBase } = c.req.valid('json');
    const base = rawBase?.trim() || undefined;
    const config = loadConfig();
    if (!config) return c.json({ error: 'no config' }, 400);
    const s = findSessionById(id);
    // The child checks again; these are the quick answers, before anything is released or spawned.
    const refusal = addRepoRefusal(s, alias, config, (p) => fs.existsSync(p), base);
    if (refusal || !s) return c.json({ error: refusal?.error ?? 'unknown session' }, refusal?.status ?? 404);
    if (running.has(id)) return c.json({ error: 'a repo is being added to this session already: wait for it' }, 409);

    running.add(id);
    try {
      await opts.release(id, s.paths);
      const r = await opts.run(id, alias, base);
      // Even a failure may have changed something (a refusal the child found): the list reads it again.
      opts.invalidate(id);
      opts.broadcast('sessions-changed', { ts: Date.now() });
      if (!r.ok) return c.json({ error: r.error }, 409);
      const after = findSessionById(id) ?? s;
      const body = addedRepoNote({ alias, ...r.wire }, agentFor(config, after).instructionsFile);
      // The repo is there whatever happens to the note: a failed one is said (the log), not fatal.
      await opts.note(id, body).catch((err: Error) => report('warn', `added ${alias}, but telling the session failed: ${err.message}`));
      return c.json(r.wire satisfies AddRepoWire);
    } finally {
      running.delete(id);
    }
  });
}
