import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as childSpawn } from 'node:child_process';
import chalk from 'chalk';
import type { Arguments, CommandModule } from 'yargs';
import { git } from '../core/git.js';
import { loadHistory, type WorktreeSession } from '../core/history.js';
import { renderDiffHtml, type RepoData } from '../core/diff-html.js';
import { computeDiff } from '../core/diff-pipeline.js';
import {
  startDiffWatcher,
  stableDiffPath,
  type RepoSpec,
} from '../core/diff-watcher.js';
import chokidar from 'chokidar';
import {
  formatSingleComment,
  startCommentServer,
} from '../core/comment-server.js';
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

// scope / base resolution
function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

interface DiffScope {
  isGroup: boolean;
  session: WorktreeSession | null;
  /** Repos to diff (1 for single, N for group). */
  repos: { name: string; root: string }[];
  /** Name of the repo whose subtree the user is in (initial active tab). */
  activeRepoName: string | null;
}

/**
 * Resolve what scope to diff based on cwd. Handles single-repo worktrees,
 * group worktrees (cwd at group root or anywhere inside a sub-repo), and
 * "random" git repos not managed by `work`.
 */
function resolveScope(cwd: string): DiffScope | null {
  const normCwd = normPath(cwd);
  const sessions = loadHistory();

  // 1. cwd is at or inside one of a session's repo paths.
  for (const s of sessions) {
    for (const p of s.paths) {
      const np = normPath(p);
      if (normCwd === np || normCwd.startsWith(np + '/')) {
        if (s.isGroup) {
          return {
            isGroup: true,
            session: s,
            repos: s.paths.map((rp) => ({ name: path.basename(rp), root: rp })),
            activeRepoName: path.basename(p),
          };
        }
        return {
          isGroup: false,
          session: s,
          repos: [{ name: path.basename(p), root: p }],
          activeRepoName: path.basename(p),
        };
      }
    }
  }

  // 2. cwd is at the group root (parent of all of a group's repo paths).
  for (const s of sessions) {
    if (!s.isGroup || s.paths.length === 0) continue;
    const parents = s.paths.map((p) => normPath(path.dirname(p)));
    const groupRoot = parents[0];
    if (!parents.every((par) => par === groupRoot)) continue;
    if (normCwd === groupRoot || normCwd.startsWith(groupRoot + '/')) {
      return {
        isGroup: true,
        session: s,
        repos: s.paths.map((rp) => ({ name: path.basename(rp), root: rp })),
        activeRepoName: null,
      };
    }
  }

  // 3. Fall back to git rev-parse for repos not managed by `work`.
  const toplevel = git(['rev-parse', '--show-toplevel'], cwd);
  if (toplevel.exitCode !== 0 || !toplevel.stdout) return null;
  return {
    isGroup: false,
    session: null,
    repos: [{ name: path.basename(toplevel.stdout), root: toplevel.stdout }],
    activeRepoName: path.basename(toplevel.stdout),
  };
}

/** Walk candidate base branches and pick the one with the most recent merge-base. */
function detectParentBranch(cwd: string): string | null {
  const currentResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const currentBranch = currentResult.exitCode === 0 ? currentResult.stdout : '';

  const candidates = ['main', 'master', 'dev', 'develop'].flatMap((name) => [
    name,
    `origin/${name}`,
  ]);

  let best: { ref: string; sha: string; time: number } | null = null;

  for (const ref of candidates) {
    if (ref === currentBranch) continue;
    const exists = git(['rev-parse', '--verify', '--quiet', ref], cwd);
    if (exists.exitCode !== 0 || !exists.stdout) continue;

    const mb = git(['merge-base', ref, 'HEAD'], cwd);
    if (mb.exitCode !== 0 || !mb.stdout) continue;

    const headSha = git(['rev-parse', 'HEAD'], cwd).stdout;
    if (mb.stdout === headSha) continue;

    const timeResult = git(['show', '-s', '--format=%ct', mb.stdout], cwd);
    if (timeResult.exitCode !== 0) continue;
    const time = Number(timeResult.stdout);
    if (!Number.isFinite(time)) continue;

    if (!best || time > best.time) {
      best = { ref, sha: mb.stdout, time };
    }
  }

  return best?.ref ?? null;
}

interface ResolvedBase {
  base: string;
  source: 'arg' | 'session' | 'auto-detected' | 'default';
}

function resolveBase(scope: DiffScope, argv: Arguments): ResolvedBase {
  const explicit = argv.base as string | undefined;
  if (explicit) return { base: explicit, source: 'arg' };

  if (argv.branch) {
    if (scope.session?.baseBranch) {
      return { base: scope.session.baseBranch, source: 'session' };
    }
    const primaryRoot =
      scope.repos.find((r) => r.name === scope.activeRepoName)?.root ??
      scope.repos[0].root;
    const detected = detectParentBranch(primaryRoot);
    if (detected) return { base: detected, source: 'auto-detected' };

    console.error(
      chalk.red('Could not determine a parent branch for this worktree.'),
    );
    console.error(chalk.gray('Pass one explicitly: diff <ref>'));
    process.exit(1);
  }

  return { base: 'HEAD', source: 'default' };
}

/** Compute per-repo merge-base when comparing against a non-HEAD ref. */
function buildRepoSpecs(scope: DiffScope, base: string): RepoSpec[] {
  return scope.repos.map((r) => {
    let diffArg = base;
    if (base !== 'HEAD') {
      const mb = git(['merge-base', base, 'HEAD'], r.root);
      if (mb.exitCode === 0 && mb.stdout) diffArg = mb.stdout;
    }
    return { name: r.name, root: r.root, diffArg };
  });
}

// paths
interface ScopePaths {
  html: string;
  pid: string;
  log: string;
}

function pathsForScope(repoSpecs: RepoSpec[]): ScopePaths {
  const html = stableDiffPath(repoSpecs.map((r) => r.root));
  return {
    html,
    pid: html.replace(/\.html$/, '.pid'),
    log: html.replace(/\.html$/, '.log'),
  };
}

// mode handlers
interface RenderContext {
  scope: DiffScope;
  base: string;
  baseSource: ResolvedBase['source'];
  repoSpecs: RepoSpec[];
  paths: ScopePaths;
  renderOpts: {
    style: 'side' | 'line';
    theme: 'light' | 'dark' | 'auto';
    subtitle: string;
    activeRepo: string | null;
  };
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
}

async function runDaemon(ctx: RenderContext): Promise<void> {
  fs.writeFileSync(ctx.paths.pid, String(process.pid));
  console.log(
    `[live] watcher started, pid=${process.pid}, repos=${ctx.repoSpecs.map((r) => r.name).join(',')}, base=${ctx.base}`,
  );
  const { stop } = startDiffWatcher({
    repos: ctx.repoSpecs,
    filePath: ctx.paths.html,
    render: { ...ctx.renderOpts, title: 'Diff (live)' },
  });
  const shutdown = () => {
    stop();
    try { fs.unlinkSync(ctx.paths.pid); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

function runLauncher(ctx: RenderContext): void {
  const existing = readPid(ctx.paths.pid);
  if (existing && isPidAlive(existing)) {
    info(chalk.gray(`Watcher already running (PID ${existing}).`));
  } else {
    try { fs.unlinkSync(ctx.paths.pid); } catch { /* stale */ }
    const passthrough = process.argv
      .slice(2)
      .filter((a) => a !== '--stop');
    const pid = spawnDaemon(passthrough, ctx.paths.log);
    info(chalk.gray(`Started watcher (PID ${pid}). Log: ${ctx.paths.log}`));
    info(chalk.gray('Stop with: wd --stop'));
  }
  info(chalk.gray(`File: ${ctx.paths.html}`));
  openUrl(`file:///${ctx.paths.html.replace(/\\/g, '/')}`);
}

async function runReview(ctx: RenderContext): Promise<void> {
  // Quick check — early-exit if nothing to review. (Server will recompute
  // on each /api/diff request thereafter, which is what's served live.)
  const initialTotal = ctx.repoSpecs.reduce(
    (s, r) => s + computeDiff({ root: r.root, diffArg: r.diffArg }).length,
    0,
  );
  if (initialTotal === 0) {
    console.log('No changes to review.');
    return;
  }

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

  const scopeLabel = `${ctx.scope.repos.map((r) => r.name).join(', ')} · ${ctx.base}`;
  const handle = await startCommentServer({
    repos: ctx.repoSpecs,
    scopeLabel,
    onComment,
    onCommentDeleted,
    onSubmitReviewStart,
    onSubmitReviewEnd,
  });

  const latestUrlFile = path.join(os.homedir(), '.work', 'diffs', 'latest-review.url');
  try {
    fs.writeFileSync(latestUrlFile, handle.url);
  } catch { /* */ }

  info(chalk.gray('Opening browser for review. Comments stream as you save them.'));
  info(chalk.gray('Page reloads automatically when you save a file. Click "End review" (or Ctrl+C) when finished.'));
  process.stdout.write(
    `--- review started ---\nrepos: ${ctx.repoSpecs.map((r) => r.name).join(', ')}\nfiles: ${initialTotal}\nurl: ${handle.url}\n\n`,
  );
  openUrl(handle.url);

  const cleanup = () => {
    handle.stop();
    try { fs.unlinkSync(latestUrlFile); } catch { /* */ }
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

function renderOnce(ctx: RenderContext): void {
  const repoData: RepoData[] = ctx.repoSpecs.map((r) => ({
    name: r.name,
    files: computeDiff({ root: r.root, diffArg: r.diffArg }),
  }));
  const total = repoData.reduce((s, r) => s + r.files.length, 0);
  if (total === 0) {
    info(chalk.gray('No changes to show.'));
    return;
  }
  const html = renderDiffHtml(repoData, {
    ...ctx.renderOpts,
    title: `Diff (${total})`,
  });
  fs.writeFileSync(ctx.paths.html, html, 'utf-8');
  info(chalk.gray(`Opening ${ctx.paths.html}`));
  openUrl(`file:///${ctx.paths.html.replace(/\\/g, '/')}`);
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
          'PR-style diff vs the branch this worktree was forked from.',
      })
      .option('side', {
        type: 'boolean',
        default: true,
        describe: 'Side-by-side layout (default). Use --no-side for unified.',
      })
      .option('theme', {
        type: 'string',
        choices: ['light', 'dark', 'auto'] as const,
        default: 'light',
        describe: 'Color scheme.',
      })
      .option('watch', {
        type: 'boolean',
        default: false,
        describe:
          'Start a background watcher that re-renders the diff file on every change. Returns immediately; F5 in the browser. Stop with --stop.',
      })
      .option('stop', {
        type: 'boolean',
        default: false,
        describe: 'Stop the background watcher for this scope.',
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

    const { base, source: baseSource } = resolveBase(scope, argv);
    const repoSpecs = buildRepoSpecs(scope, base);
    const paths = pathsForScope(repoSpecs);

    const subtitle =
      base === 'HEAD' ? 'uncommitted changes' : `vs ${base} (uncommitted included)`;
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

    const ctx: RenderContext = {
      scope,
      base,
      baseSource,
      repoSpecs,
      paths,
      renderOpts: {
        style: (argv.side ? 'side' : 'line') as 'side' | 'line',
        theme: argv.theme as 'light' | 'dark' | 'auto',
        subtitle,
        activeRepo: scope.activeRepoName,
      },
    };

    if (argv.stop) return runStop(ctx.paths);
    if (argv['watch-daemon']) return runDaemon(ctx);
    if (argv.watch) return runLauncher(ctx);
    if (argv.comments) return runReview(ctx);
    return renderOnce(ctx);
  },
};
