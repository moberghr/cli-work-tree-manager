import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import chalk from 'chalk';
import chokidar from 'chokidar';
import { computeDiff } from './diff-pipeline.js';
import type { ParsedFile } from './diff-parse.js';
import {
  renderDiffHtml,
  type RenderOptions,
  type RepoData,
} from './diff-html.js';

export interface RepoSpec {
  /** Display name (becomes tab label / repo slug). */
  name: string;
  /** Git working tree root for this repo. */
  root: string;
  /** Argument to `git diff` (sha or ref like HEAD). */
  diffArg: string;
}

export interface WatchOptions {
  repos: RepoSpec[];
  render: RenderOptions;
  /** Output file path the daemon writes to. */
  filePath: string;
  /** Debounce window for filesystem events, in ms. */
  debounceMs?: number;
  /** Safety regen interval. */
  safetyPollMs?: number;
}

/** Stable per-scope HTML file path. Pass `[root]` for single repo, all roots
 *  (sorted) for a group. The hash means each scope has its own file. */
export function stableDiffPath(keyPaths: string[]): string {
  const key = keyPaths.slice().sort().join('|');
  const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  const dir = path.join(os.homedir(), '.work', 'diffs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.html`);
}

/** Match a filesystem path to the repo whose root contains it, if any. */
function repoForPath(repos: RepoSpec[], filePath: string): RepoSpec | null {
  const norm = path.resolve(filePath);
  for (const r of repos) {
    const rRoot = path.resolve(r.root);
    if (norm === rRoot || norm.startsWith(rRoot + path.sep)) {
      return r;
    }
  }
  return null;
}

export function startDiffWatcher(opts: WatchOptions): {
  filePath: string;
  stop: () => void;
} {
  const debounceMs = opts.debounceMs ?? 150;
  const safetyPollMs = opts.safetyPollMs ?? 30_000;
  const filePath = opts.filePath;
  let lastHash = '';

  // Per-repo cache: avoid recomputing the diff for repos that didn't change.
  // Initial regen marks all repos dirty so every cache is populated.
  const filesCache = new Map<string, ParsedFile[]>();
  const dirty = new Set<string>(opts.repos.map((r) => r.name));

  function regenerate(reason: string): boolean {
    try {
      const repoData: RepoData[] = opts.repos.map((r) => {
        if (!dirty.has(r.name) && filesCache.has(r.name)) {
          return { name: r.name, files: filesCache.get(r.name)! };
        }
        const files = computeDiff({ root: r.root, diffArg: r.diffArg });
        filesCache.set(r.name, files);
        return { name: r.name, files };
      });
      dirty.clear();

      const html = renderDiffHtml(repoData, {
        ...opts.render,
        liveReload: true,
      });
      const h = crypto.createHash('sha1').update(html).digest('hex');
      if (h === lastHash) return false;
      lastHash = h;
      fs.writeFileSync(filePath, html, 'utf-8');
      console.log(chalk.gray(`[live] ${reason}: diff written to ${filePath}`));
      return true;
    } catch (err) {
      console.error(chalk.red('[live] regen failed:'), (err as Error).message);
      return false;
    }
  }

  regenerate('initial');

  let debounceTimer: NodeJS.Timeout | null = null;
  let pendingReason = '';
  function scheduleCheck(reason: string) {
    pendingReason = reason;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      regenerate(pendingReason);
    }, debounceMs);
  }

  // chokidar watches every repo root in the scope. .git/ in each repo is
  // ignored — git itself writes constantly into those dirs.
  const watchRoots = opts.repos.map((r) => r.root);
  const watcher = chokidar.watch(watchRoots, {
    ignored: (filePath) => {
      for (const r of opts.repos) {
        const rel = path.relative(r.root, filePath).replace(/\\/g, '/');
        if (rel === '.git' || rel.startsWith('.git/')) return true;
      }
      return false;
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });
  watcher.on('all', (event, p) => {
    const repo = repoForPath(opts.repos, p);
    if (repo) dirty.add(repo.name);
    scheduleCheck(`${event}: ${p}`);
  });
  watcher.on('error', (err) => {
    console.error(chalk.yellow('[live] fs watcher error:'), (err as Error).message);
  });

  const safetyPoll = setInterval(() => {
    // Safety poll re-checks everything in case fs.watch missed events.
    for (const r of opts.repos) dirty.add(r.name);
    regenerate('safety poll');
  }, safetyPollMs);

  const stop = () => {
    clearInterval(safetyPoll);
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close().catch(() => { /* */ });
  };

  return { filePath, stop };
}
