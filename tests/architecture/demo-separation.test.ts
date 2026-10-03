import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The demo proves the dashboard depends only on its API contract — but only
 * while the demo itself stays free of the real machinery. These rules keep
 * it honest:
 *
 *   1. src/server/demo/ imports (at runtime) only modules that do no real I/O
 *      of their own: server plumbing, the pure comment model and diff
 *      parser, the shared wire types. `import type` is free (erased).
 *   2. Every route the real dashboard server registers exists in the demo,
 *      so the SPA can't depend on something the contract doesn't cover.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const RUNTIME_IMPORT = /^\s*import\s+(?!type\b)[^'"]*?from\s*['"]([^'"]+)['"]/gm;

/** Route modules that are not part of the dashboard SPA's contract. */
const NOT_DASHBOARD = new Map([
  // `wd`'s per-scope review API (/diff/<hash>, /review/<hash>) and the
  // Stop-hook checkpoint bridge: called by `wd` and `work hook`, not the dashboard.
  ['scope-routes.ts', 'wd scopes + checkpoint hook'],
]);

describe('demo mode is separated from the real machinery', () => {
  const demoFiles = fs.readdirSync(path.join(ROOT, 'src/server/demo')).filter((f) => f.endsWith('.ts'));

  it('src/server/demo imports no git / history / config / PTY / ~/.work modules at runtime', () => {
    const allowedLocal = new Set([
      'src/server/local-server.ts', // 127.0.0.1 + Host/Origin guard
      'src/server/local-origin.ts',
      'src/server/spa-handler.ts', // serves the built SPA files
      'src/core/comments/comment-schemas.ts', // zod input validation
      'src/core/comments/comment-store.ts', // in-memory comment model
      'src/core/diff/diff-parse.ts', // pure unified-diff parser
      'src/core/api-types.ts',
      'src/core/status/attention.ts',
      'src/server/presence.ts', // pure who's-watching registry
      'src/core/pr/pr-watch.ts', // pure PR-watch policy (all I/O injected)
      'src/core/diff/overlap.ts', // pure: which sessions change the same files
      'src/core/sessions/saved-prompts.ts', // pure: the default one-click prompts
      'src/core/conversations/digest.ts', // pure: the Today digest from given inputs
      'src/core/platform/build-stamp.ts', // one stat of the entry file
      'src/core/cleanup/cleanup-verdict.ts', // pure: what to do with a worktree, given its git facts
      'src/core/rail/session-order.ts', // pure: the sessions list's manual order
      'src/core/platform/activity.ts', // pure: the in-memory Activity log
      'src/core/rail/snooze.ts', // pure: when a snooze ends
      'src/core/rail/rail-layout.ts', // pure: the rail's pins and sections
      'src/core/conversations/work-time-view.ts', // pure: worked time in words
      'src/core/conversations/work-time.ts', // pure: worked time from transcript entries (the digest's)
      'src/core/stacks/stack.ts', // pure: which session is stacked on which
      'src/core/rail/blocks.ts', // pure: what a session waits on
      'src/core/conversations/timeline.ts', // pure: a session's history on one line
      'src/core/pty/host-health.ts', // pure: how the PTY host is doing
      'src/core/worktree/branch-name.ts', // pure: the next free branch name
    ]);
    const allowedPackages = new Set(['hono', 'hono/streaming', 'ws']);
    const offenders: string[] = [];
    for (const f of demoFiles) {
      const rel = `src/server/demo/${f}`;
      for (const m of read(rel).matchAll(RUNTIME_IMPORT)) {
        const spec = m[1];
        if (spec.startsWith('.')) {
          const target = path.posix.normalize(path.posix.join('src/server/demo', spec)).replace(/\.js$/, '.ts');
          if (!target.startsWith('src/server/demo/') && !allowedLocal.has(target)) offenders.push(`${rel} → ${target}`);
        } else if (!allowedPackages.has(spec)) {
          offenders.push(`${rel} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every dashboard route of the real server is implemented by the demo', () => {
    const ROUTE = /app\.(get|post|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    const routes = (files: string[]) =>
      new Set(files.flatMap((f) => [...read(f).matchAll(ROUTE)].map((m) => `${m[1].toUpperCase()} ${m[2]}`)));
    // Every route module, not a hand list: a new *-routes.ts is covered the
    // day it lands (the old list had silently fallen three files behind).
    const routeModules = fs
      .readdirSync(path.join(ROOT, 'src/server/routes'))
      .filter((f) => f.endsWith('-routes.ts') && !NOT_DASHBOARD.has(f))
      .map((f) => `src/server/routes/${f}`);
    const real = routes(['src/server/web-server.ts', ...routeModules]);
    // Not part of the dashboard's contract: the Claude hook nudge (called
    // by `work hook`, not the SPA) and the SPA fallback itself.
    for (const r of ['POST /api/status-changed', 'GET *']) real.delete(r);
    // The demo's routes may live in any of its files (demo-replies.ts, …).
    const demo = routes(
      fs
        .readdirSync(path.join(ROOT, 'src/server/demo'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `src/server/demo/${f}`),
    );
    const missing = [...real].filter((r) => !demo.has(r)).sort();
    expect(missing).toEqual([]);
    expect(real.size).toBeGreaterThan(20); // the scan really found the routes
  });
});
