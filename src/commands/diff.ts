import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as childSpawn } from 'node:child_process';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { computeDiff } from '../core/diff-pipeline.js';
import { stableDiffPath, type RepoSpec } from '../core/repo-spec.js';
import {
  buildRepoSpecs,
  findAnyParentBranch,
  resolveBase,
  resolveScope,
  type DiffScope,
  type ResolvedBase,
} from '../core/diff-scope.js';
import {
  formatSingleComment,
  startCommentServer,
} from '../core/comment-server.js';
import { diffReviewSnapshot } from '../core/review-poll.js';
import { renderStatic } from '../core/static-renderer.js';
import { openUrl } from '../utils/platform.js';

/** Write an informational message to stderr. Keeps stdout clean so it can
 *  be piped or captured by callers (notably `wd -c` review mode, where
 *  stdout carries the comments markdown payload). */
function info(message: string): void {
  process.stderr.write(message + '\n');
}

/** Per-scope stable filesystem stem under ~/.work/diffs/. Used by the
 *  static-render path to pick its output filename and (legacy) by the
 *  `wd -c` comment-server fallback. */
function scopePathStem(repoSpecs: RepoSpec[]): string {
  return stableDiffPath(repoSpecs.map((r) => r.root));
}

// mode handlers
interface RenderContext {
  scope: DiffScope;
  base: string;
  baseSource: ResolvedBase['source'];
  repoSpecs: RepoSpec[];
  /** Stable filesystem stem (no extension) under ~/.work/diffs/. The
   *  static-render path appends `.html` to get its output file. */
  scopeStem: string;
  scopeLabel: string;
}

/**
 * `wd --stop`: de-register this scope from the running work web. The
 * work web process itself keeps running — it's a singleton serving
 * every scope, so killing the server because one user stopped one
 * review would punish every other open tab. Use `work web --stop`
 * to terminate the server.
 */
async function runStop(repoSpecs: RepoSpec[]): Promise<void> {
  const webUrl = readWebUrl();
  if (!webUrl) {
    info(chalk.gray('No work web running — nothing to stop.'));
    return;
  }
  // Compute the same scope hash work web does (sha1 of sorted root
  // paths) and DELETE it. `scope-routes.ts` clears the auto-snapshot
  // subscriber + manifest as part of that handler.
  const hash = stableDiffPath(repoSpecs.map((r) => r.root))
    .split(/[\\/]/)
    .pop()!;
  try {
    const res = await fetch(`${webUrl}api/scopes/${hash}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      info(chalk.gray('De-registered this scope from work web.'));
    } else {
      info(
        chalk.yellow(
          `work web responded ${res.status} — scope may not have been registered.`,
        ),
      );
    }
  } catch (err) {
    console.error(
      chalk.red('Could not reach work web:'),
      (err as Error).message,
    );
  }
}

function webUrlFilePath(): string {
  return path.join(os.homedir(), '.work', 'web.url');
}

/**
 * Resolve the path to the `work` binary given the path of whichever
 * binary `wd`/`work` is currently running as. The `web` subcommand
 * only lives on the `work` binary (`dist/bin.js`); when we're running
 * as the `wd` shim (`dist/wd-bin.js`) we swap to the sibling. Tsup
 * ships both into the same dir so the sibling-swap is always valid.
 *
 * Exported for testing — the autostart spawn relies on this to avoid
 * passing `web --lean` to a binary that only knows `diff`.
 */
export function resolveWorkBinPath(selfArgv1: string): string {
  // argv[1] may be a bin symlink, not the real file: a global npm install
  // exposes `wd` as e.g. ~/.../bin/wd -> ../lib/.../dist/wd-bin.js. Resolve
  // it so the wd-bin.js -> bin.js sibling-swap fires for global installs too;
  // otherwise we'd spawn the `wd` shim with `web` args and it'd fail.
  let real = selfArgv1;
  try {
    real = fs.realpathSync(selfArgv1);
  } catch {
    /* synthetic/non-existent path (e.g. unit tests) — use as given */
  }
  if (real.endsWith('wd-bin.js')) {
    return path.join(path.dirname(real), 'bin.js');
  }
  return real;
}

function readWebUrl(): string | null {
  try {
    const v = fs.readFileSync(webUrlFilePath(), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Spawn a detached, lean `work web` instance and wait for its url file
 * to appear. Used when `wd` runs with no existing work web — instead of
 * starting a per-scope standalone daemon, we boot a single shared
 * server in "lean" mode (skips the Claude activity watcher + hook
 * installation) and route every subsequent `wd` invocation through it.
 *
 * Returns the discovered URL on success, null on timeout. Safe against
 * a concurrent `wd` racing to do the same thing: the second `work web`
 * detects the singleton via the pid file and exits cleanly; the first
 * winner's url file is what both invocations end up reading.
 */
async function ensureWorkWebRunning(): Promise<string | null> {
  const existing = readWebUrl();
  if (existing) return existing;

  // Spawn `node <work-bin> web --lean --no-open` detached. We're
  // running as either `dist/bin.js` (the `work` binary) or
  // `dist/wd-bin.js` (the `wd` shim). The `web` subcommand only
  // lives on the `work` binary; `resolveWorkBinPath` does the sibling
  // swap when we're the shim.
  const workBin = resolveWorkBinPath(process.argv[1]);
  const out = fs.openSync(
    path.join(os.homedir(), '.work', 'web-autostart.log'),
    'a',
  );
  const child = childSpawn(
    process.execPath,
    [workBin, 'web', '--lean', '--no-open'],
    {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      // Inherit cwd doesn't matter for work web — its file-watches use
      // ~/.work paths exclusively.
    },
  );
  child.unref();
  fs.closeSync(out);

  // Poll the url file. Generous-ish timeout because cold startup
  // includes resolving the SPA dist + binding a port + writing the
  // file; 5 s leaves headroom for slow disks / antivirus on Windows.
  const url = await waitForUrlFile(webUrlFilePath(), 5000);
  return url;
}

/**
 * Try to register this scope with a running (or just-spawned) `work
 * web` server. Returns the browser URL to open
 * (e.g. `http://127.0.0.1:54321/diff/abc123`) on success, null when
 * everything (existing instance + autostart) failed.
 */
async function tryRegisterWithWorkWeb(
  ctx: RenderContext,
  routeKind: 'diff' | 'review',
): Promise<string | null> {
  const webUrl = await ensureWorkWebRunning();
  if (!webUrl) return null;
  try {
    const res = await fetch(`${webUrl}api/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ctx.repoSpecs.map((r) => r.root),
        label: ctx.scopeLabel,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { hash: string };
    const route = routeKind === 'diff' ? 'diff' : 'review';
    return `${webUrl}${route}/${body.hash}`;
  } catch {
    return null;
  }
}

/** Foreground launcher: opens a diff in the browser via `work web`. When
 *  no work web is running, we auto-start a lean one (`tryRegisterWithWorkWeb`
 *  handles the spawn + wait) — a single server backs every `wd` invocation
 *  across all worktrees, no per-scope daemon class. */
async function runLauncher(ctx: RenderContext): Promise<void> {
  const webRouteUrl = await tryRegisterWithWorkWeb(ctx, 'diff');
  if (webRouteUrl) {
    info(chalk.gray(`Opening: ${webRouteUrl}`));
    openUrl(webRouteUrl);
    return;
  }
  // Reached only on autostart failure (port refused, dist/web missing,
  // 5 s wait elapsed). Surface a clear error rather than silently
  // falling back to a per-scope process the user would then leak.
  console.error(
    chalk.red('Could not start or reach work web.'),
  );
  console.error(
    chalk.gray(
      `Tail ~/.work/web-autostart.log for diagnostics, or run \`work web\` in another shell to inspect startup directly.`,
    ),
  );
  process.exitCode = 1;
}

/**
 * Static-file mode (the default for `wd`). Renders the React SPA shell
 * with the diff data inlined, writes it to ~/.work/diffs/<hash>.html,
 * opens the browser at file://…, and exits. No server, no daemon, no
 * port — the file works forever (modulo your filesystem). Same React
 * components and screens as the live server: file tree, scrollspy,
 * viewed checkboxes, syntax highlighting, intra-line diff.
 *
 * Trade-off: no live reload, no comments. Use `wd --server` (or `wd -c`
 * for review mode) when you need those.
 */
function runStatic(ctx: RenderContext, initialBranch: boolean): void {
  // Always compute the uncommitted scope (cheap, the user expects it as
  // the default tab).
  const uncommitted = buildRepoSpecs(ctx.scope, 'HEAD');

  // Try to resolve a parent branch for each repo. If we find one, compute
  // the "since branch" scope too so the SPA can offer the toggle. If not,
  // the tab simply doesn't appear.
  //
  // Group worktrees: each sub-repo may have a different parent. We pick a
  // representative resolvedBase from the active repo (or the first one)
  // for the badge label; per-repo merge-base lookups still happen inside
  // buildRepoSpecs.
  const primaryRoot =
    ctx.scope.repos.find((r) => r.name === ctx.scope.activeRepoName)?.root ??
    ctx.scope.repos[0].root;
  // Per-repo fork points (group worktrees forked with different bases). Each
  // repo's spec resolves against its own base inside buildRepoSpecs.
  const perRepoBase = ctx.scope.session?.baseBranches;
  // Representative parent for the badge label: the active repo's recorded
  // base, else the session default, else lenient auto-detect. The lenient
  // finder keeps the toggle available even when the branch has no commits
  // past its parent yet (the diff just renders empty — better than no tab).
  const parent =
    perRepoBase?.[primaryRoot] ??
    ctx.scope.session?.baseBranch ??
    findAnyParentBranch(primaryRoot);
  const branch =
    parent === null
      ? undefined
      : {
          specs: buildRepoSpecs(ctx.scope, parent, perRepoBase),
          resolvedBase: parent,
        };

  // Don't write a file when both views are empty — `wd` is a viewer,
  // not a generator of empty pages.
  const uncommittedTotal = uncommitted.reduce(
    (s, r) => s + computeDiff({ root: r.root, diffArg: r.diffArg }).length,
    0,
  );
  const branchTotal = branch
    ? branch.specs.reduce(
        (s, r) => s + computeDiff({ root: r.root, diffArg: r.diffArg }).length,
        0,
      )
    : 0;
  if (uncommittedTotal === 0 && branchTotal === 0) {
    info(chalk.gray('No changes to show.'));
    return;
  }

  const html = renderStatic({
    scopeLabel: ctx.scopeLabel,
    uncommitted,
    branch,
    initialBase: initialBranch && branch ? 'branch' : 'uncommitted',
  });
  const filePath = `${ctx.scopeStem}.html`;
  fs.writeFileSync(filePath, html, 'utf-8');
  info(chalk.gray(`Wrote ${filePath}`));
  openUrl(`file:///${filePath.replace(/\\/g, '/')}`);
}

function waitForUrlFile(filePath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      try {
        const v = fs.readFileSync(filePath, 'utf-8').trim();
        if (v) return resolve(v);
      } catch { /* not yet */ }
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 75);
    };
    tick();
  });
}

/**
 * Try to route `wd -c` through a running `work web`. Registers the scope
 * as a reviewable view, opens the browser at /review/<hash>, then polls
 * the scope's comments and proxies them to stdout as the markers the
 * `wd-review` skill consumes (`--- review started ---`,
 * `--- comment ---`, etc.). Returns true if work web handled the review;
 * the caller falls back to a standalone server when this returns false.
 */
async function tryReviewViaWorkWeb(ctx: RenderContext): Promise<boolean> {
  const webUrl = await ensureWorkWebRunning();
  if (!webUrl) return false;

  let hash: string;
  try {
    const res = await fetch(`${webUrl}api/scopes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ctx.repoSpecs.map((r) => r.root),
        label: ctx.scopeLabel,
      }),
    });
    if (!res.ok) return false;
    hash = ((await res.json()) as { hash: string }).hash;
  } catch {
    return false;
  }

  const initialTotal = ctx.repoSpecs.reduce(
    (s, r) => s + computeDiff({ root: r.root, diffArg: r.diffArg }).length,
    0,
  );
  const reviewUrl = `${webUrl}review/${hash}`;
  info(chalk.gray(`Opening review in work web: ${reviewUrl}`));
  info(chalk.gray('Comments stream below. Ctrl+C to detach.'));
  process.stdout.write(
    `--- review started ---\nrepos: ${ctx.repoSpecs.map((r) => r.name).join(', ')}\nfiles: ${initialTotal}\nurl: ${reviewUrl}\n\n`,
  );
  openUrl(reviewUrl);

  // Poll the scope's comments. Cheap (one localhost JSON GET) and
  // simpler than reading SSE chunks in Node. The skill latency budget
  // is generous so 1s is fine.
  const seen = new Set<string>();
  let exiting = false;
  let interval: NodeJS.Timeout | null = null;
  // Reentrancy guard. `setInterval(poll, 1000)` fires every second
  // regardless of whether the previous tick has resolved. A slow `work
  // web` response (>1s) would otherwise let two `poll()`s mutate `seen`
  // concurrently. JS being single-threaded makes interleaving impossible
  // for synchronous blocks but the await points do let two flows
  // interleave — duplicate `--- review done ---` markers if `ended:true`
  // races with a slow prior poll.
  let polling = false;

  type SnapshotComment = import('../core/comment-types.js').Comment;

  async function poll(): Promise<void> {
    if (exiting || polling) return;
    polling = true;
    try {
      const res = await fetch(`${webUrl}api/scopes/${hash}/comments`);
      if (res.status === 404) {
        // Scope is gone (user explicitly removed it). Treat like
        // End Review for the marker stream.
        process.stdout.write(`--- review done ---\ntotal: ${seen.size}\n`);
        cleanup();
        process.exit(0);
      }
      if (!res.ok) return;
      const { comments, ended } = (await res.json()) as {
        comments: SnapshotComment[];
        ended?: boolean;
      };
      // Compute deltas before checking `ended` so any comments posted
      // in the same batch as End Review still flush through.
      const { newComments, deleted } = diffReviewSnapshot(comments, seen);
      for (const id of deleted) {
        process.stdout.write(`--- comment deleted ---\nid: ${id}\n\n`);
      }
      for (const c of newComments) {
        process.stdout.write(formatSingleComment(c));
      }
      // End Review fired: emit the done marker and exit. The scope
      // (and the browser tab) stays viewable — only the CLI proxy
      // stops.
      if (ended) {
        process.stdout.write(
          `--- review done ---\ntotal: ${seen.size}\n`,
        );
        cleanup();
        process.exit(0);
      }
    } catch { /* transient — retry next tick */ }
    finally { polling = false; }
  }

  function cleanup(): void {
    exiting = true;
    if (interval) clearInterval(interval);
    // Don't deregister — the browser tab and URL should keep working
    // after the CLI exits. Scopes live in work web's memory until it
    // restarts or the user removes them from the dashboard.
  }

  const onSignal = () => {
    process.stdout.write(`--- review aborted (signal) ---\n`);
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Arm the interval BEFORE the first poll. If the first poll triggers
  // cleanup (e.g. scope already ended, 404), `cleanup()` clears this
  // interval correctly — otherwise the previous shape left a small window
  // where setInterval would be assigned AFTER cleanup ran, which mocked
  // tests reproduced (the real runtime survives because process.exit is
  // synchronous, but tests that stub process.exit would leak the timer).
  interval = setInterval(poll, 1000);
  await poll();
  // Block forever — cleanup happens via signal or 404 detection.
  await new Promise(() => {});
  return true;
}

async function runReview(ctx: RenderContext): Promise<void> {
  // Quick check — early-exit if nothing to review. (Server will recompute
  // on each /api/diff request thereafter, which is what's served live.)
  const initialTotal = ctx.repoSpecs.reduce(
    (s, r) => s + computeDiff({ root: r.root, diffArg: r.diffArg }).length,
    0,
  );
  if (initialTotal === 0) {
    info(chalk.gray('No changes to review.'));
    return;
  }

  // Prefer work web when it's running — same consolidation pattern as
  // `wd` (read-only). The CLI proxies the marker stream so the
  // wd-review skill flow is unchanged. Falls back to a standalone
  // comment-server when work web isn't up.
  if (await tryReviewViaWorkWeb(ctx)) return;

  const onComment = (c: import('../core/comment-server.js').Comment) => {
    process.stdout.write(formatSingleComment(c));
  };
  const onCommentDeleted = (id: string) => {
    process.stdout.write(`--- comment deleted ---\nid: ${id}\n\n`);
  };
  const onSubmitReviewStart = (info: {
    count: number;
    summary: import('../core/comment-server.js').Comment | null;
  }) => {
    const head = `--- review submitted ---\ncount: ${info.count}${info.summary ? `\nsummary-id: ${info.summary.id}` : ''}\n\n`;
    process.stdout.write(head);
  };
  const onSubmitReviewEnd = () => {
    process.stdout.write(`--- review batch end ---\n\n`);
  };

  const handle = await startCommentServer({
    repos: ctx.repoSpecs,
    scopeLabel: ctx.scopeLabel,
    sessionBaseBranch: ctx.scope.session?.baseBranch,
    sessionBaseBranches: ctx.scope.session?.baseBranches,
    onComment,
    onCommentDeleted,
    onSubmitReviewStart,
    onSubmitReviewEnd,
  });

  // URL discovery is intentionally not persisted to disk. The only
  // consumer (Claude via the wd-review skill) reads it from the
  // `--- review started ---` marker on stdout below. Skipping the
  // file write removes the only way a stale or wrong URL could leak
  // into a different Claude session.
  info(chalk.gray('Opening browser for review. Comments stream as you save them.'));
  info(chalk.gray('Page reloads automatically when you save a file. Click "End review" (or Ctrl+C) when finished.'));
  process.stdout.write(
    `--- review started ---\nrepos: ${ctx.repoSpecs.map((r) => r.name).join(', ')}\nfiles: ${initialTotal}\nurl: ${handle.url}\n\n`,
  );
  openUrl(handle.url);

  const cleanup = () => {
    handle.stop();
  };

  const onSignal = () => {
    process.stdout.write(`--- review aborted (signal) ---\n`);
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const comments = await handle.waitForDone();
  await new Promise((r) => setTimeout(r, 100));
  cleanup();
  process.stdout.write(`--- review done ---\ntotal: ${comments.length}\n`);
}

// command export
export const diffCommand: CommandModule = {
  command: 'diff [base]',
  describe: 'Open a GitHub-PR-style diff overview in your browser',
  builder: (yargs) =>
    yargs
      .positional('base', {
        describe:
          'Base ref to compare against. Default: HEAD (uncommitted only). Use --branch for a full PR-style diff vs the parent branch.',
        type: 'string',
      })
      .option('branch', {
        type: 'boolean',
        default: false,
        describe:
          'Open the "Since branch" tab by default (still shows uncommitted as the other tab — toggle in the browser).',
      })
      .option('static', {
        type: 'boolean',
        default: false,
        describe:
          'Write a self-contained HTML file with the current diff inlined (no server, no live reload). The default is a live server you can refresh.',
      })
      .option('server', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe:
          'Run a live server (now the default; flag kept for back-compat).',
      })
      .option('watch', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe: 'Alias for --server. Kept for back-compat.',
      })
      .option('stop', {
        type: 'boolean',
        default: false,
        describe:
          "De-register this scope from work web. The work web server itself keeps running; use `work web --stop` to terminate the server.",
      })
      .option('comments', {
        type: 'boolean',
        alias: 'c',
        default: false,
        describe:
          'Review mode: open the diff in a browser with a comment UI; block until you click "Done & Send", then print all comments to stdout as markdown.',
      }),
  handler: async (argv) => {
    const scope = resolveScope(process.cwd());
    if (!scope) {
      console.error(chalk.red('Not inside a git repository or known worktree.'));
      process.exit(1);
    }

    const { base, source: baseSource } = resolveBase(scope, {
      base: argv.base as string | undefined,
      branch: argv.branch as boolean | undefined,
    });
    const repoSpecs = buildRepoSpecs(scope, base);
    const scopeStem = scopePathStem(repoSpecs);

    // `wd --stop` doesn't need the full ctx — it only needs the repo
    // specs to derive the scope hash. Short-circuit before the
    // status-message block so a stop call stays quiet.
    if (argv.stop) return runStop(repoSpecs);

    // Use stderr for status messages so review mode's stdout stays clean
    // (the comments markdown is the only data wd writes to stdout).
    if (base === 'HEAD') {
      info(chalk.gray('Showing uncommitted changes vs HEAD.'));
    } else {
      info(
        chalk.gray(
          `Showing diff vs ${base} [${baseSource}]${scope.isGroup ? `, across ${scope.repos.length} repos` : ''}.`,
        ),
      );
    }

    const scopeLabel = `${scope.repos.map((r) => r.name).join(', ')} · ${base}`;
    const ctx: RenderContext = {
      scope,
      base,
      baseSource,
      repoSpecs,
      scopeStem,
      scopeLabel,
    };

    if (argv.comments) return runReview(ctx);
    if (argv.static) return runStatic(ctx, !!argv.branch);
    // Default: live server via work web. `runLauncher` registers the
    // scope (auto-spawning a lean work web when one isn't running).
    return runLauncher(ctx);
  },
};
