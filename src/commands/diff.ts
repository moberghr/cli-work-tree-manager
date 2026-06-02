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
  startReadOnlyDiffServer,
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

// pid / process helpers
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidPath: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function spawnDaemon(extraArgs: string[], logPath: string): number {
  const out = fs.openSync(logPath, 'a');
  const child = childSpawn(
    process.execPath,
    [process.argv[1], ...extraArgs, '--watch-daemon'],
    {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      cwd: process.cwd(),
    },
  );
  child.unref();
  fs.closeSync(out);
  return child.pid ?? 0;
}

// paths
interface ScopePaths {
  /** Stable per-scope key; the daemon writes a URL file here. */
  base: string;
  pid: string;
  log: string;
  url: string;
}

function pathsForScope(repoSpecs: RepoSpec[]): ScopePaths {
  const base = stableDiffPath(repoSpecs.map((r) => r.root));
  return {
    base,
    pid: `${base}.pid`,
    log: `${base}.log`,
    url: `${base}.url`,
  };
}

// mode handlers
interface RenderContext {
  scope: DiffScope;
  base: string;
  baseSource: ResolvedBase['source'];
  repoSpecs: RepoSpec[];
  paths: ScopePaths;
  scopeLabel: string;
}

function runStop(paths: ScopePaths): void {
  const pid = readPid(paths.pid);
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid);
      info(chalk.gray(`Stopped watcher (PID ${pid}).`));
    } catch (err) {
      console.error(chalk.red('Failed to stop watcher:'), (err as Error).message);
    }
  } else {
    info(chalk.gray('No watcher running for this scope.'));
  }
  try { fs.unlinkSync(paths.pid); } catch { /* */ }
  try { fs.unlinkSync(paths.url); } catch { /* */ }
}

/** Foreground daemon entrypoint. Starts the read-only review server and
 *  blocks until killed. The launcher reads the printed URL from the log. */
async function runDaemon(ctx: RenderContext): Promise<void> {
  fs.writeFileSync(ctx.paths.pid, String(process.pid));
  const handle = await startReadOnlyDiffServer({
    repos: ctx.repoSpecs,
    scopeLabel: ctx.scopeLabel,
    sessionBaseBranch: ctx.scope.session?.baseBranch,
  });
  fs.writeFileSync(ctx.paths.url, handle.url);
  info(
    chalk.gray(
      `[live] watcher started, pid=${process.pid}, repos=${ctx.repoSpecs.map((r) => r.name).join(',')}, base=${ctx.base}, url=${handle.url}`,
    ),
  );
  const shutdown = () => {
    handle.stop();
    try { fs.unlinkSync(ctx.paths.pid); } catch { /* */ }
    try { fs.unlinkSync(ctx.paths.url); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

/**
 * Try to register this scope with a running `work web` server. Returns
 * the browser URL to open (e.g. `http://127.0.0.1:54321/diff/abc123`)
 * when work web is up and accepting registrations, null otherwise.
 *
 * Reads `~/.work/web.url` for the discovery handshake. Failure paths
 * (file missing, server unreachable, register endpoint returns non-200)
 * all yield null cleanly — the caller falls back to spawning its own
 * standalone daemon.
 */
async function tryRegisterWithWorkWeb(
  ctx: RenderContext,
  routeKind: 'diff' | 'review',
): Promise<string | null> {
  const webUrlFile = path.join(os.homedir(), '.work', 'web.url');
  let webUrl: string;
  try {
    webUrl = fs.readFileSync(webUrlFile, 'utf-8').trim();
    if (!webUrl) return null;
  } catch {
    return null;
  }
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

/** Foreground launcher: opens a diff in the browser. Prefers a running
 *  `work web` (registers a scope, opens /diff/<hash>) so a single server
 *  process backs every `wd` invocation. Falls back to spawning a
 *  standalone daemon when work web isn't running. */
async function runLauncher(ctx: RenderContext): Promise<void> {
  // Try work web first. When the dashboard is running, every `wd`
  // invocation lives inside that one server — no extra processes, no
  // extra ports, browser-bookmarkable URLs.
  const webRouteUrl = await tryRegisterWithWorkWeb(ctx, 'diff');
  if (webRouteUrl) {
    info(chalk.gray(`Opening in work web: ${webRouteUrl}`));
    openUrl(webRouteUrl);
    return;
  }

  // Fallback: standalone daemon. Same lifecycle we had before
  // (pid + url + log files keyed by scope hash).
  const existing = readPid(ctx.paths.pid);
  let url: string | null = null;
  if (existing && isPidAlive(existing)) {
    info(chalk.gray(`Watcher already running (PID ${existing}).`));
    try { url = fs.readFileSync(ctx.paths.url, 'utf-8').trim(); } catch { /* */ }
  } else {
    try { fs.unlinkSync(ctx.paths.pid); } catch { /* stale */ }
    try { fs.unlinkSync(ctx.paths.url); } catch { /* stale */ }
    const passthrough = process.argv
      .slice(2)
      .filter((a) => a !== '--stop' && a !== '--watch');
    const pid = spawnDaemon(passthrough, ctx.paths.log);
    info(chalk.gray(`Started watcher (PID ${pid}). Log: ${ctx.paths.log}`));
    info(chalk.gray('Stop with: wd --stop'));
    url = await waitForUrlFile(ctx.paths.url, 3000);
  }
  if (!url) {
    console.error(
      chalk.red('Watcher did not report a URL — check the log:'),
      ctx.paths.log,
    );
    return;
  }
  info(chalk.gray(`URL: ${url}`));
  openUrl(url);
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
  // Use the lenient finder so the toggle stays available even when the
  // branch has no commits past its parent yet (the diff will just be
  // empty — better than no tab at all).
  const parent =
    ctx.scope.session?.baseBranch ?? findAnyParentBranch(primaryRoot);
  const branch =
    parent === null
      ? undefined
      : {
          specs: buildRepoSpecs(ctx.scope, parent),
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
  const filePath = `${ctx.paths.base}.html`;
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
  const webUrlFile = path.join(os.homedir(), '.work', 'web.url');
  let webUrl: string;
  try {
    webUrl = fs.readFileSync(webUrlFile, 'utf-8').trim();
    if (!webUrl) return false;
  } catch {
    return false;
  }

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
        describe: 'Stop the background server for this scope.',
      })
      .option('watch-daemon', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe: 'Internal: run the foreground watcher loop.',
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
    const paths = pathsForScope(repoSpecs);

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
      paths,
      scopeLabel,
    };

    if (argv.stop) return runStop(ctx.paths);
    if (argv['watch-daemon']) return runDaemon(ctx);
    if (argv.comments) return runReview(ctx);
    if (argv.static) return runStatic(ctx, !!argv.branch);
    // Default: live server. Refresh in the browser to see changes; stop
    // with `wd --stop`. Use --static for a self-contained HTML file.
    return runLauncher(ctx);
  },
};
