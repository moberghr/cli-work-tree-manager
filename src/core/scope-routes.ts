import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import spawn from 'cross-spawn';
import { computeDiff, computeRangeDiff } from './diff-pipeline.js';
import { readContextLines } from './file-context.js';
import { resolveRepoDiff, sessionBaseForPath } from './diff-scope.js';
import { git } from './git.js';
import {
  clearCheckpoints,
  loadManifest,
  setCheckpointLabel,
  takeCheckpoint,
  type CheckpointEntry,
} from './checkpoint.js';
import { summarizeCheckpoint } from './checkpoint-summary.js';
import { getClaudeActivityMs, claudeActiveWithin } from './claude-activity.js';
import {
  commentStoreIdForScope,
  getScope,
  listScopes,
  markScopeEnded,
  registerScope,
  removeScope,
  reviveScope,
  ScopePathRejectedError,
  scopesForCwd,
  subscribeScope,
  suppressScopeWatch,
} from './scope-manager.js';
import { getCommentFileStore } from './comment-file-store.js';
import {
  commentInputSchema,
  resolveSchema,
  submitReviewSchema,
} from './comment-schemas.js';
import { streamSSE } from 'hono/streaming';

export interface ScopeMountOptions {
  /** Server-level broadcast. Scope events go here too. */
  broadcast: (event: string, data: unknown) => void;
}


/**
 * Hono sub-app exposing the per-scope diff + review surface that lets
 * `wd` and `wd -c` consolidate onto the `work web` server.
 *
 * Routes:
 *   POST   /api/scopes                       — register a scope; returns
 *                                              `{ hash, diffUrl, reviewUrl }`
 *   GET    /api/scopes                       — list active scopes
 *   DELETE /api/scopes/:hash                 — deregister
 *   GET    /api/scopes/:hash/diff?base=…     — diff data (same shape as
 *                                              session diff)
 *   GET    /api/scopes/:hash/comments        — list comments
 *   POST   /api/scopes/:hash/comments        — add (zod-validated)
 *   DELETE /api/scopes/:hash/comments/:cid   — remove
 *   POST   /api/scopes/:hash/submit-review   — promote drafts
 *   POST   /api/scopes/:hash/discard-review  — drop drafts
 *   GET    /api/scopes/:hash/events          — SSE: diff-changed,
 *                                              comments-changed
 */
export function mountScopeRoutes(app: Hono, opts: ScopeMountOptions): void {
  // -- Lifecycle -----------------------------------------------------------

  // Scopes that already have an auto-snapshot subscriber wired. The
  // register endpoint is idempotent (same paths → same hash), and we
  // only want one subscriber per scope no matter how many times `wd`
  // re-registers in the same `work web` lifetime.
  const checkpointWatched = new Set<string>();

  // Per-scope fingerprint of the last working-tree state we observed.
  // `git status --porcelain --no-renames -z` is dramatically cheaper
  // than the full snapshot path (`git add -A` against a temp index +
  // write-tree + commit-tree + update-ref ≈ 6 spawns per repo) — when
  // a save touches an `.gitignore`'d file or doesn't actually change
  // content (editor rewriting the same bytes), the status output is
  // unchanged and we can skip the whole snapshot pipeline.
  const lastStatus = new Map<string, string>();

  // Per-scope coalescing timer for auto-snapshots. Rather than checkpointing
  // on every 150ms fs-watch burst (one checkpoint per file-save — far too
  // granular to be meaningful), we wait for edits to settle AND for Claude's
  // transcript to go quiet, so a whole turn's worth of changes collapses into
  // ONE checkpoint. Hook-free (reads ~/.claude/projects mtimes), so it works
  // in the lean `wd` autostart that installs no Claude hooks.
  const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Working tree must be quiet this long before the timer snapshots. */
  const CHECKPOINT_SETTLE_MS = 4000;
  /** If Claude wrote its transcript within this window, a session is active
   *  for the scope and the Stop hook owns checkpoints — the timer suppresses
   *  itself entirely so it can never fire before/around a Claude turn. The
   *  timer only acts when no Claude has been active for this long (manual
   *  edits with no session). */
  const CLAUDE_SESSION_MS = 5 * 60_000;

  function workingTreeFingerprint(paths: string[]): string {
    const parts: string[] = [];
    for (const p of paths) {
      const r = spawn.sync(
        'git',
        ['status', '--porcelain', '--no-renames', '-z'],
        { cwd: p, encoding: 'utf-8', windowsHide: true },
      );
      parts.push(r.stdout ?? '');
    }
    return parts.join('\0|\0');
  }

  // In-process bus for checkpoint events — lets the per-scope SSE handler
  // forward `checkpoints-changed` to subscribers of a single scope's
  // stream. Server-level `/events` still gets the same event via
  // `opts.broadcast`; both paths are needed because the SPA chooses one
  // stream or the other depending on whether it's mounted via `work web`
  // or running standalone.
  const scopeBus = new EventEmitter();
  scopeBus.setMaxListeners(0);

  /** Broadcast a comment event on BOTH streams: the server-level /events
   *  stream and the scope-narrowed /api/scopes/:hash/events stream (via
   *  scopeBus). The review SPA listens on the scope stream so each tab
   *  holds a single SSE connection instead of one per concern. */
  function emitCommentsChanged(
    payload: { scopeHash: string } & Record<string, unknown>,
  ): void {
    opts.broadcast('comments-changed', payload);
    scopeBus.emit('comments-changed', payload);
  }

  /** Build the repo list for `takeCheckpoint`. The `name` field is the
   *  manifest key — must be unique within a scope, otherwise two repos
   *  with the same basename in a group worktree would overwrite each
   *  other's SHA in the entry. Using the full resolved path guarantees
   *  uniqueness (paths in a scope are already de-duplicated by
   *  `registerScope`'s sort+normalise). */
  function scopeRepos(scopePaths: string[]) {
    return scopePaths.map((p) => ({ name: p, root: p }));
  }

  app.post(
    '/api/scopes',
    zValidator(
      'json',
      z.object({
        paths: z.array(z.string().min(1)).min(1),
        label: z.string().optional(),
      }),
    ),
    (c) => {
      const { paths, label } = c.req.valid('json');
      try {
        const scope = registerScope(paths, label);

        // Re-registering an ENDED scope means a new `wd -c` run on the same
        // paths. Reset the flag and clear the previous run's comments —
        // otherwise the CLI proxy replays the old comments as new and sees
        // `ended: true` on its first poll, emitting `--- review done ---`
        // immediately.
        if (reviveScope(scope.hash)) {
          const cleared = commentStore(scope.hash).clearAll();
          if (cleared > 0) {
            emitCommentsChanged({ scopeHash: scope.hash });
          }
        }

        opts.broadcast('scopes-changed', { hash: scope.hash });

        const announceCheckpoint = (entry: CheckpointEntry) => {
          const payload = { scopeHash: scope.hash, id: entry.id };
          opts.broadcast('checkpoints-changed', payload);
          scopeBus.emit('checkpoints-changed', payload);
        };

        // Initial snapshot — establishes the "Initial" checkpoint that
        // every subsequent fs-change snapshot diffs against. Fire and
        // forget: `git add -A` against a large untracked tree can take
        // hundreds of ms, and the `wd` foreground caller is waiting on
        // this response to open the browser. The SPA fetches checkpoints
        // separately and will see the initial entry once it lands (or
        // via the `checkpoints-changed` SSE event below).
        if (loadManifest(scope.hash).entries.length === 0) {
          takeCheckpoint(scope.hash, scopeRepos(scope.paths))
            .then((entry) => {
              if (entry) announceCheckpoint(entry);
            })
            .catch((err) => {
              // Best-effort, but DO surface persistent failures (disk
              // full on `~/.work/diffs/`, stale lockfile, git permission
              // denied). `installConsoleLogger` mirrors console.error
              // into `~/.work/debug.log`, giving the user a diagnostic
              // trail even though we don't fail the request.
              console.error('[checkpoint] initial snapshot failed:', err);
            });
        }

        // Wire an auto-snapshot subscriber that fires on every debounced
        // fs change for this scope. A cheap `git status` fingerprint
        // gate short-circuits before the expensive snapshot pipeline
        // when the working tree hasn't moved — common when editor
        // autosave rewrites a file with identical content, or when
        // chokidar fires for an `.gitignore`'d path that git wouldn't
        // capture anyway.
        if (!checkpointWatched.has(scope.hash)) {
          checkpointWatched.add(scope.hash);
          const hash = scope.hash;
          // Fires once the edit burst settles. Defers while Claude is still
          // writing its transcript so the checkpoint maps to a finished turn,
          // then runs the cheap status-fingerprint gate before the expensive
          // snapshot pipeline.
          const runSnapshot = () => {
            snapshotTimers.delete(hash);
            const claudeMs = scope.paths.reduce(
              (m, p) => Math.max(m, getClaudeActivityMs(p)),
              0,
            );
            if (claudeActiveWithin(claudeMs, Date.now(), CLAUDE_SESSION_MS)) {
              // A Claude session is active for this scope — the Stop hook is
              // authoritative for checkpoints, so the timer stands down. This
              // is what guarantees the timer can never snapshot before Claude
              // finishes a turn. It only acts below when no Claude is around.
              return;
            }
            try {
              const fp = workingTreeFingerprint(scope.paths);
              if (lastStatus.get(hash) === fp) return;
              lastStatus.set(hash, fp);
            } catch {
              // Fingerprint failure shouldn't block the snapshot — fall
              // through to takeCheckpoint and let its own logic decide.
            }
            takeCheckpoint(hash, scopeRepos(scope.paths))
              .then((entry) => {
                if (entry) announceCheckpoint(entry);
              })
              .catch((err) => {
                console.error('[checkpoint] auto-snapshot failed:', err);
              });
          };
          // Coalesce: every fs burst resets the settle timer, so a flurry of
          // saves produces one checkpoint at the end, not one per save.
          subscribeScope(hash, () => {
            const pending = snapshotTimers.get(hash);
            if (pending) clearTimeout(pending);
            snapshotTimers.set(hash, setTimeout(runSnapshot, CHECKPOINT_SETTLE_MS));
          });
        }

        return c.json({
          hash: scope.hash,
          diffUrl: `/diff/${scope.hash}`,
          reviewUrl: `/review/${scope.hash}`,
        });
      } catch (err) {
        if (err instanceof ScopePathRejectedError) {
          return c.json({ error: err.message, rejected: err.rejected }, 403);
        }
        throw err;
      }
    },
  );

  app.get('/api/scopes', (c) => c.json({ scopes: listScopes() }));

  // Stop-hook bridge: `work hook checkpoint` POSTs the Claude cwd here when a
  // turn ends, giving us the authoritative, precise per-turn checkpoint. We
  // snapshot every scope covering that cwd; dedup-by-tree makes a turn that
  // changed nothing a no-op. No-op (200) when the cwd isn't a tracked scope —
  // the Stop hook is global and fires for every Claude session.
  app.post(
    '/api/checkpoint',
    zValidator('json', z.object({ cwd: z.string().min(1) })),
    async (c) => {
      const { cwd } = c.req.valid('json');
      const matched = scopesForCwd(cwd);
      let snapshotted = 0;
      for (const s of matched) {
        const entry = await takeCheckpoint(s.hash, scopeRepos(s.paths)).catch(
          () => null,
        );
        if (entry) {
          const payload = { scopeHash: s.hash, id: entry.id };
          opts.broadcast('checkpoints-changed', payload);
          scopeBus.emit('checkpoints-changed', payload);
          snapshotted++;
        }
      }
      return c.json({ ok: true, scopes: matched.length, snapshotted });
    },
  );

  app.delete('/api/scopes/:hash', (c) => {
    const hash = c.req.param('hash');
    // Capture the paths BEFORE removeScope — the scope-manager entry
    // is gone after that, and clearCheckpoints needs the repo roots
    // to delete each `refs/wd/<hash>/<n>` ref. Without this cleanup,
    // refs + the manifest leak forever: git GC can't reclaim the
    // commits behind a named ref, and a re-register with the same
    // paths would skip the Initial snapshot because the stale
    // manifest still has entries.
    const scope = getScope(hash);
    const repoPaths = scope ? [...scope.paths] : [];
    const ok = removeScope(hash);
    // `removeScope` clears the scope's fs-watch subscribers; drop our
    // record of having wired one so a re-register of the same paths
    // rewires the auto-snapshot subscriber instead of silently doing
    // nothing.
    checkpointWatched.delete(hash);
    lastStatus.delete(hash);
    const pendingTimer = snapshotTimers.get(hash);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      snapshotTimers.delete(hash);
    }
    if (repoPaths.length > 0) clearCheckpoints(hash, repoPaths);
    if (ok) opts.broadcast('scopes-changed', { hash });
    return c.json({ ok });
  });

  // -- Diff ----------------------------------------------------------------

  /** Parse "0", "1", ... as a numeric id; everything else as undefined.
   *  The literal "working" stays as the sentinel — only meaningful for
   *  the `to` parameter. */
  function parseCheckpointParam(
    raw: string | undefined,
  ): number | 'working' | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (raw === 'working') return 'working';
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
    return undefined;
  }

  app.get('/api/scopes/:hash/diff', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const base = c.req.query('base') === 'branch' ? 'branch' : 'uncommitted';
    const fromParam = parseCheckpointParam(c.req.query('from'));
    const toParam = parseCheckpointParam(c.req.query('to'));
    try {
      // `from='working'` is meaningless — the working tree only makes
      // sense as the right endpoint. Reject explicitly instead of
      // silently falling through to legacy mode and serving a HEAD-vs-
      // working diff that looks like the requested range.
      if (fromParam === 'working') {
        return c.json(
          { error: "'working' is not valid as a from-checkpoint" },
          400,
        );
      }
      // Checkpoint-range mode: ignore `base`, look up commits from the
      // manifest, run computeRangeDiff per repo. Either endpoint can be
      // an id or (for `to`) 'working'. Missing checkpoint id for a repo
      // → fall back to HEAD (treats that repo as if there's no snapshot).
      if (fromParam !== undefined) {
        const manifest = loadManifest(scope.hash);
        const fromEntry = manifest.entries.find((e) => e.id === fromParam);
        if (!fromEntry) {
          return c.json({ error: `unknown from checkpoint ${fromParam}` }, 400);
        }
        let toEntry: CheckpointEntry | undefined;
        if (toParam !== undefined && toParam !== 'working') {
          toEntry = manifest.entries.find((e) => e.id === toParam);
          if (!toEntry) {
            return c.json({ error: `unknown to checkpoint ${toParam}` }, 400);
          }
          // Reject reversed ranges. `git diff <toSha> <fromSha>` produces
          // an inverted diff (adds look like deletes) — clearly wrong but
          // would still return 200. Surface the misuse so callers (the
          // SPA or curl users) get a clear error instead of confusing
          // output.
          if (toEntry.id < fromEntry.id) {
            return c.json(
              { error: `to (${toEntry.id}) must be >= from (${fromEntry.id})` },
              400,
            );
          }
        }
        const repos = scope.paths.map((p) => {
          // Manifest is keyed by full path (see `scopeRepos`). The
          // response's `name` is still the basename — it's the user-
          // visible repo tab label and doesn't need to be unique-by-key.
          const fromSha = fromEntry.repos[p] ?? 'HEAD';
          const toSha: string | 'working' =
            toEntry === undefined ? 'working' : (toEntry.repos[p] ?? 'HEAD');
          return {
            name: path.basename(p),
            root: p,
            files: computeRangeDiff({ root: p, fromRef: fromSha, toRef: toSha }),
          };
        });
        // Suppress the fs-watch churn our own git commands (writeTempTree's
        // `git add -A` for a `to=working` range) just produced — otherwise it
        // fires `diff-changed` → refetch → recompute → loop.
        suppressScopeWatch(scope.hash, 800);
        return c.json({
          scopeHash: scope.hash,
          base: 'uncommitted',
          resolvedBase: `checkpoint-${fromEntry.id}`,
          from: fromEntry.id,
          to: toEntry?.id ?? 'working',
          repos,
        });
      }

      // Resolve each repo independently — they may have different parent
      // branches in a group worktree. Each entry carries its own
      // `resolvedBase` so the UI can label per-repo if it wants to. The
      // recorded fork point (`work tree --base`) wins over auto-detection,
      // per-repo — so a group forked `backend=dev frontend=feat/x` diffs
      // each repo against its own base.
      const resolved = scope.paths.map((p) =>
        resolveRepoDiff(p, base, sessionBaseForPath(p)),
      );
      const repos = scope.paths.map((p, i) => ({
        name: path.basename(p),
        root: p,
        resolvedBase: resolved[i].resolvedBase,
        files: computeDiff({ root: p, diffArg: resolved[i].diffArg }),
      }));
      // Top-level `resolvedBase` is the primary repo's value — used for
      // the single-line "vs X" badge in the sidebar header. Mirrors what
      // session-diff returns from web-server.ts.
      const resolvedBase = resolved[0]?.resolvedBase ?? 'HEAD';
      // Current branch of the primary repo, for the "<branch> vs <base>"
      // title. In work-web mode the SPA synthesizes its context from the
      // URL hash (no headBranch), so it reads this off the diff instead.
      const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], scope.paths[0]);
      const headBranch =
        head.exitCode === 0 && head.stdout && head.stdout !== 'HEAD'
          ? head.stdout
          : undefined;
      // Same self-churn suppression as the range branch (e.g. the
      // HEAD-vs-working `git diff` refreshing `.git/index`).
      suppressScopeWatch(scope.hash, 800);
      return c.json({
        scopeHash: scope.hash,
        base,
        resolvedBase,
        headBranch,
        repos,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // -- Expand context ------------------------------------------------------
  //
  // Reveals the unchanged lines around a hunk ("expand lines" in the SPA).
  // The expandable region is identical on both diff sides, so the client
  // reads one side and maps old line numbers via the gap offset. `ref` is
  // omitted for the common working-tree case; supplied (a checkpoint sha)
  // when the diff's new side is a committed snapshot.
  app.get('/api/scopes/:hash/file-lines', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const repoName = c.req.query('repo') ?? '';
    const relPath = c.req.query('path') ?? '';
    const start = Number(c.req.query('start'));
    const end = Number(c.req.query('end'));
    const ref = c.req.query('ref') || undefined;
    if (!relPath || !Number.isInteger(start) || !Number.isInteger(end)) {
      return c.json({ error: 'bad path/start/end' }, 400);
    }
    // Resolve the repo root. Single-repo scopes have exactly one path;
    // group scopes key each repo's response `name` by basename, so match
    // the same way the diff route labels them.
    const root =
      scope.paths.length === 1
        ? scope.paths[0]
        : scope.paths.find((p) => path.basename(p) === repoName);
    if (!root) return c.json({ error: 'unknown repo' }, 404);
    const result = readContextLines({ root, relPath, start, end, ref });
    if (!result) return c.json({ error: 'cannot read file' }, 400);
    return c.json(result);
  });

  // -- Checkpoints ---------------------------------------------------------

  app.get('/api/scopes/:hash/checkpoints', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const manifest = loadManifest(scope.hash);
    return c.json({
      scopeHash: scope.hash,
      entries: manifest.entries,
    });
  });

  // Lazy + cached Claude summary of what changed at a checkpoint. The SPA
  // calls this for the selected `to` endpoint; the result is persisted to
  // the manifest `label` so it's generated at most once per checkpoint.
  app.post('/api/scopes/:hash/checkpoints/:id/summary', async (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 0) {
      return c.json({ error: 'bad checkpoint id' }, 400);
    }
    const entry = loadManifest(scope.hash).entries.find((e) => e.id === id);
    if (!entry) return c.json({ error: 'unknown checkpoint' }, 404);
    // Cached, or the Initial baseline (nothing to summarise).
    if (entry.label && entry.label.trim()) return c.json({ label: entry.label });
    if (id === 0) return c.json({ label: 'Initial' });

    const label = await summarizeCheckpoint(scope.hash, scopeRepos(scope.paths), id);
    await setCheckpointLabel(scope.hash, id, label);
    opts.broadcast('checkpoints-changed', { scopeHash: scope.hash, id });
    return c.json({ label });
  });

  // -- Comments ------------------------------------------------------------

  function commentStore(hash: string) {
    return getCommentFileStore(commentStoreIdForScope(hash));
  }

  app.get('/api/scopes/:hash/comments', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    return c.json({
      comments: commentStore(scope.hash).snapshot(),
      ended: scope.ended,
    });
  });

  app.post(
    '/api/scopes/:hash/comments',
    zValidator('json', commentInputSchema),
    (c) => {
      const scope = getScope(c.req.param('hash'));
      if (!scope) return c.json({ error: 'unknown scope' }, 404);
      const store = commentStore(scope.hash);
      try {
        const comment = store.post(c.req.valid('json'));
        emitCommentsChanged({
          scopeHash: scope.hash,
          id: comment.id,
        });
        return c.json({ comment, comments: store.snapshot() });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  app.delete('/api/scopes/:hash/comments/:cid', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const store = commentStore(scope.hash);
    const removed = store.remove(c.req.param('cid'));
    if (removed) {
      emitCommentsChanged({
        scopeHash: scope.hash,
        deleted: c.req.param('cid'),
      });
    }
    return c.json({ comments: store.snapshot() });
  });

  app.post(
    '/api/scopes/:hash/comments/:cid/resolve',
    zValidator('json', resolveSchema),
    (c) => {
      const scope = getScope(c.req.param('hash'));
      if (!scope) return c.json({ error: 'unknown scope' }, 404);
      const store = commentStore(scope.hash);
      const updated = store.setResolved(
        c.req.param('cid'),
        c.req.valid('json').resolved,
      );
      if (updated) {
        emitCommentsChanged({
          scopeHash: scope.hash,
          id: updated.id,
        });
      }
      return c.json({ comments: store.snapshot() });
    },
  );

  app.post(
    '/api/scopes/:hash/submit-review',
    zValidator('json', submitReviewSchema),
    (c) => {
      const scope = getScope(c.req.param('hash'));
      if (!scope) return c.json({ error: 'unknown scope' }, 404);
      const store = commentStore(scope.hash);
      const result = store.submit(c.req.valid('json').summary);
      emitCommentsChanged({
        scopeHash: scope.hash,
        submittedCount: result.drafts.length,
      });
      return c.json({
        count: result.drafts.length,
        comments: store.snapshot(),
      });
    },
  );

  app.post('/api/scopes/:hash/discard-review', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const store = commentStore(scope.hash);
    const discarded = store.discardDrafts();
    if (discarded > 0) {
      emitCommentsChanged({ scopeHash: scope.hash });
    }
    return c.json({ discarded, comments: store.snapshot() });
  });

  // End Review button hits this. Sets the scope's `ended` flag so the
  // `wd -c` CLI proxy can emit `--- review done ---` and exit on the
  // next poll. Scope itself stays alive — the browser tab keeps
  // working, reloading the URL keeps working.
  app.post('/api/scopes/:hash/done', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const store = commentStore(scope.hash);
    const count = store.list().length;
    markScopeEnded(scope.hash);
    const payload = { scopeHash: scope.hash, count };
    opts.broadcast('review-done', payload);
    scopeBus.emit('review-done', payload);
    return c.json({ ok: true, count });
  });

  // -- Per-scope SSE -------------------------------------------------------
  //
  // The shared /events stream already broadcasts global events; this
  // endpoint adds a scope-narrowed stream so the `wd -c` CLI can tail
  // *just* its scope's comments without filtering at the client.

  app.get('/api/scopes/:hash/events', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeScope(scope.hash, () => {
        stream
          .writeSSE({
            event: 'diff-changed',
            data: JSON.stringify({ scopeHash: scope.hash }),
          })
          .catch(() => { /* */ });
      });
      // Relay checkpoint events for THIS scope only. The auto-snapshot
      // subscriber emits to `scopeBus` whenever a new checkpoint passes
      // the dedup, so the SPA's strip refreshes without polling.
      const onCheckpoint = (payload: { scopeHash: string; id: number }) => {
        if (payload.scopeHash !== scope.hash) return;
        stream
          .writeSSE({
            event: 'checkpoints-changed',
            data: JSON.stringify(payload),
          })
          .catch(() => { /* */ });
      };
      scopeBus.on('checkpoints-changed', onCheckpoint);
      // Relay comment + review-lifecycle events for THIS scope so the
      // review SPA can subscribe to one stream per tab (instead of also
      // holding the global /events stream open — browsers cap concurrent
      // connections per host, and stale review tabs were starving the
      // pool, leaving fresh tabs stuck on "Loading diff…").
      const onComments = (payload: { scopeHash: string }) => {
        if (payload.scopeHash !== scope.hash) return;
        stream
          .writeSSE({
            event: 'comments-changed',
            data: JSON.stringify(payload),
          })
          .catch(() => { /* */ });
      };
      scopeBus.on('comments-changed', onComments);
      const onDone = (payload: { scopeHash: string }) => {
        if (payload.scopeHash !== scope.hash) return;
        stream
          .writeSSE({
            event: 'review-done',
            data: JSON.stringify(payload),
          })
          .catch(() => { /* */ });
      };
      scopeBus.on('review-done', onDone);
      await stream.writeSSE({ event: 'connected', data: '' });
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe?.();
          scopeBus.off('checkpoints-changed', onCheckpoint);
          scopeBus.off('comments-changed', onComments);
          scopeBus.off('review-done', onDone);
          resolve();
        });
      });
    });
  });
}
