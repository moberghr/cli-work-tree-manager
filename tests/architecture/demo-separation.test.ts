import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The demo proves the dashboard depends only on its API contract — but only
 * while the demo itself stays free of the real machinery. These rules keep
 * it honest:
 *
 *   1. src/core/demo/ imports (at runtime) only modules that do no real I/O
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
  const demoFiles = fs.readdirSync(path.join(ROOT, 'src/core/demo')).filter((f) => f.endsWith('.ts'));

  it('src/core/demo imports no git / history / config / PTY / ~/.work modules at runtime', () => {
    const allowedLocal = new Set([
      'src/core/local-server.ts', // 127.0.0.1 + Host/Origin guard
      'src/core/local-origin.ts',
      'src/core/spa-handler.ts', // serves the built SPA files
      'src/core/comment-schemas.ts', // zod input validation
      'src/core/comment-store.ts', // in-memory comment model
      'src/core/diff-parse.ts', // pure unified-diff parser
      'src/core/api-types.ts',
      'src/core/attention.ts',
      'src/core/presence.ts', // pure who's-watching registry
      'src/core/pr-watch.ts', // pure PR-watch policy (all I/O injected)
      'src/core/overlap.ts', // pure: which sessions change the same files
      'src/core/saved-prompts.ts', // pure: the default one-click prompts
      'src/core/digest.ts', // pure: the Today digest from given inputs
      'src/core/transcript-entry.ts', // pure: transcript line shapes
    ]);
    const allowedPackages = new Set(['hono', 'hono/streaming', 'ws']);
    const offenders: string[] = [];
    for (const f of demoFiles) {
      const rel = `src/core/demo/${f}`;
      for (const m of read(rel).matchAll(RUNTIME_IMPORT)) {
        const spec = m[1];
        if (spec.startsWith('.')) {
          const target = path.posix.normalize(path.posix.join('src/core/demo', spec)).replace(/\.js$/, '.ts');
          if (!target.startsWith('src/core/demo/') && !allowedLocal.has(target)) offenders.push(`${rel} → ${target}`);
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
    const routeModules = fs.readdirSync(path.join(ROOT, 'src/core'))
      .filter((f) => f.endsWith('-routes.ts') && !NOT_DASHBOARD.has(f))
      .map((f) => `src/core/${f}`);
    const real = routes(['src/core/web-server.ts', ...routeModules]);
    // Not part of the dashboard's contract: the Claude hook nudge (called
    // by `work hook`, not the SPA) and the SPA fallback itself.
    for (const r of ['POST /api/status-changed', 'GET *']) real.delete(r);
    const demo = routes(['src/core/demo/demo-server.ts']);
    const missing = [...real].filter((r) => !demo.has(r)).sort();
    expect(missing).toEqual([]);
    expect(real.size).toBeGreaterThan(20); // the scan really found the routes
  });
});
