import { launch, type DiffServerHandle } from './local-server.js';

export { launch, type DiffServerHandle } from './local-server.js';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { computeDiff } from '../core/diff/diff-pipeline.js';
import { readContextLines } from '../core/diff/file-context.js';
import { createFsWatcher } from '../core/platform/fs-watcher.js';
import { resolveRepoDiff } from '../core/diff/diff-scope.js';
import { git } from '../core/git/git.js';
import { resolveWebRoot } from '../core/platform/web-static.js';
import { serveSpa } from './spa-handler.js';
import type { RepoSpec } from '../core/diff/repo-spec.js';

export interface DiffServerOptions {
  /** Repos this server scopes to. */
  repos: RepoSpec[];
  /** Short human-readable label for /api/context. */
  scopeLabel: string;
  /** Optional session baseBranch (the value captured at `work tree --base`).
   *  When set, the `?base=branch` route uses it instead of auto-detection,
   *  so the diff matches what the user actually declared. */
  sessionBaseBranch?: string;
  /** Per-repo fork points keyed by repo root. Overrides `sessionBaseBranch`
   *  for individual repos in a group forked with different bases per repo. */
  sessionBaseBranches?: Record<string, string>;
  /** Debounce for fs.watch events before broadcasting diff-changed. */
  watchDebounceMs?: number;
  /** When true, /api/context advertises readOnly=true and the SPA hides
   *  the comment UI. Default false. */
  readOnly?: boolean;
  /** Called once the base app is built so feature apps (e.g. comments) can
   *  mount themselves and emit events via the SSE hub. */
  attachRoutes?: (api: DiffServerApi) => void;
}

/** A typed SSE event broadcast to every connected client. */
export interface SseEvent {
  event: string;
  data: unknown;
}

export interface DiffServerApi {
  /** Mount a Hono sub-app at the given path prefix. */
  route(prefix: string, app: Hono): void;
  /** Broadcast on the shared SSE hub. Fan-out is one-shot per client. */
  broadcast(event: string, data: unknown): void;
}

/**
 * The shared local HTTP server used by both `wd` (read-only) and `wd -c`
 * (comments). Owns the fs watcher, the SSE hub, and the three routes every
 * mode needs: GET /api/context, GET /api/diff, GET /events. Comment routes
 * register themselves via `attachRoutes`.
 */
export async function startDiffServer(opts: DiffServerOptions): Promise<DiffServerHandle> {
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    throw new Error('Could not find dist/web/. Run `npm run build` first.');
  }

  const sseListeners = new Set<(e: SseEvent) => void>();
  const watcher = createFsWatcher({
    roots: opts.repos.map((r) => r.root),
    debounceMs: opts.watchDebounceMs,
    onChange: () => broadcast('diff-changed', { ts: Date.now() }),
  });

  function broadcast(event: string, data: unknown): void {
    const payload: SseEvent = { event, data };
    for (const cb of sseListeners) cb(payload);
  }

  const app = new Hono();
  // No CORS headers and no OPTIONS preflight handler — the SPA is served
  // same-origin so its requests don't trigger preflight. The Host guard in
  // `launch` rejects cross-origin requests before they reach any handler.

  app.get('/api/context', (c) => {
    // Current branch of the primary repo, for the "<branch> vs <base>" title.
    const primaryRoot = opts.repos[0]?.root;
    let headBranch: string | undefined;
    if (primaryRoot) {
      const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], primaryRoot);
      if (head.exitCode === 0 && head.stdout && head.stdout !== 'HEAD') {
        headBranch = head.stdout;
      }
    }
    return c.json({
      mode: 'review',
      scopeLabel: opts.scopeLabel,
      repos: opts.repos.map((r) => ({ name: r.name })),
      readOnly: !!opts.readOnly,
      headBranch,
    });
  });

  app.get('/api/diff', (c) => {
    const base = c.req.query('base') === 'branch' ? 'branch' : 'uncommitted';
    try {
      // For 'uncommitted' we honour the configured `diffArg` (typically
      // HEAD) so single-repo callers preserve whatever ref they
      // configured. For 'branch' we delegate to `resolveRepoDiff` per
      // repo — each one resolves its own parent and merge-base. The
      // top-level `resolvedBase` is the primary repo's value (matches
      // scope-routes and web-server behavior for the badge label).
      const resolved = opts.repos.map((r) =>
        base === 'uncommitted'
          ? { resolvedBase: 'HEAD', diffArg: r.diffArg }
          : resolveRepoDiff(r.root, 'branch', opts.sessionBaseBranches?.[r.root] ?? opts.sessionBaseBranch),
      );
      const repos = opts.repos.map((r, i) => ({
        name: r.name,
        root: r.root,
        resolvedBase: resolved[i].resolvedBase,
        files: computeDiff({ root: r.root, diffArg: resolved[i].diffArg }),
      }));
      const resolvedBase = resolved[0]?.resolvedBase ?? 'HEAD';
      return c.json({ repos, base, resolvedBase });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Reveal unchanged context lines around a hunk ("expand lines"). Maps the
  // SPA's repo name back to its RepoSpec root; single-repo scopes (the
  // common standalone case) skip the lookup.
  app.get('/api/file-lines', (c) => {
    const repoName = c.req.query('repo') ?? '';
    const relPath = c.req.query('path') ?? '';
    const start = Number(c.req.query('start'));
    const end = Number(c.req.query('end'));
    const ref = c.req.query('ref') || undefined;
    if (!relPath || !Number.isInteger(start) || !Number.isInteger(end)) {
      return c.json({ error: 'bad path/start/end' }, 400);
    }
    const root = opts.repos.length === 1 ? opts.repos[0].root : opts.repos.find((r) => r.name === repoName)?.root;
    if (!root) return c.json({ error: 'unknown repo' }, 404);
    const result = readContextLines({ root, relPath, start, end, ref });
    if (!result) return c.json({ error: 'cannot read file' }, 400);
    return c.json(result);
  });

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const listener = (e: SseEvent) => {
        stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) }).catch(() => {
          /* client gone */
        });
      };
      sseListeners.add(listener);
      await stream.writeSSE({ event: 'connected', data: '' });
      // Keep the stream open until the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sseListeners.delete(listener);
          resolve();
        });
      });
    }),
  );

  // attachRoutes can mount Hono sub-apps with their own routes.
  if (opts.attachRoutes) {
    opts.attachRoutes({
      route: (prefix, sub) => app.route(prefix, sub),
      broadcast,
    });
  }

  // SPA fallback for the bundled web assets.
  app.get('*', (c: Context) => serveSpa(c, webRoot));

  // Wrap the handle so server shutdown also tears down our chokidar watcher.
  // Without this the watcher keeps Node's event loop open after `stop()` —
  // a real test/teardown leak (vitest hangs after a suite that exercises
  // the server) and a wasteful long-running ghost in dev.
  const handle = await launch(app);
  const baseStop = handle.stop;
  return {
    ...handle,
    stop: async () => {
      try {
        watcher.stop();
      } catch {
        /* */
      }
      await baseStop();
    },
  };
}
