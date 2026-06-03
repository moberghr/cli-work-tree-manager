import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import chokidar from 'chokidar';

export interface FsWatcherOptions {
  /** Working-tree roots to watch. .git/ subdirs are filtered out. */
  roots: string[];
  /** Debounce window for fs events before firing `onChange`. */
  debounceMs?: number;
  /** Fires once per debounce window when anything under `roots` changed. */
  onChange: () => void;
}

export interface FsWatcher {
  stop(): void;
}

/**
 * Directory names the watcher must never descend into. chokidar (v4+, no
 * fsevents) opens one OS watch per directory, so recursively watching a
 * dependency install or build-output tree exhausts the process's file
 * descriptors (EMFILE) and wedges the server. These are all git-ignored in
 * practice, so changes there never affect the diff — at worst a manual
 * browser refresh is needed for an edit inside one.
 */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'bin', // .NET build output
  'obj', // .NET build output
  'dist',
  'build',
  'out',
  'target', // Rust / JVM
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.gradle',
  'coverage',
  '.vs',
  '.idea',
]);

/**
 * Whether chokidar should skip a path. A path is ignored when any segment
 * *below one of the watched roots* is in {@link IGNORED_DIRS}. Matching
 * relative to the root (not the absolute path) avoids false positives when an
 * ancestor directory happens to be named e.g. `build`.
 */
export function isIgnoredWatchPath(roots: string[], filePath: string): boolean {
  for (const root of roots) {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('../')) continue; // not under this root
    if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return true;
  }
  return false;
}

// macOS and Windows support recursive fs.watch (backed by FSEvents /
// ReadDirectoryChangesW) — a single OS handle covers the whole tree with
// O(1) file descriptors. Linux has no recursive fs.watch, so we keep
// chokidar there.
const SUPPORTS_RECURSIVE_WATCH =
  process.platform === 'darwin' || process.platform === 'win32';

function logWatchError(err: unknown): void {
  process.stderr.write(
    chalk.yellow('[watcher] fs error: ') + (err as Error).message + '\n',
  );
}

/**
 * Debounced recursive watcher over one-or-more repo roots, filtering out
 * `.git/`, `node_modules/`, and build output. Shared between `wd` (the diff
 * server's reload trigger) and any other live file-watcher need.
 *
 * On macOS/Windows this uses one recursive `fs.watch` per root: O(1) fds no
 * matter how big the tree. chokidar (v4 — no bundled fsevents) instead opens
 * one watch per directory, which on a large repo exhausts the process's file
 * descriptors and starves the `git` subprocesses the diff server spawns
 * (branch detection then silently returns nothing). Linux keeps chokidar.
 */
export function createFsWatcher(opts: FsWatcherOptions): FsWatcher {
  const debounceMs = opts.debounceMs ?? 150;
  let debounceTimer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      opts.onChange();
    }, debounceMs);
  };

  if (SUPPORTS_RECURSIVE_WATCH) {
    const watchers = opts.roots.map((root) => {
      const w = fs.watch(root, { recursive: true }, (_event, filename) => {
        // `filename` is relative to `root` (and may be null on some events).
        // The single FSEvents handle still reports ignored dirs, so filter
        // here to avoid spurious reloads from node_modules / build churn.
        if (
          filename &&
          isIgnoredWatchPath([root], path.join(root, filename.toString()))
        ) {
          return;
        }
        fire();
      });
      w.on('error', logWatchError);
      return w;
    });
    return {
      stop() {
        if (debounceTimer) clearTimeout(debounceTimer);
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* already closed */
          }
        }
      },
    };
  }

  const watcher = chokidar.watch(opts.roots, {
    ignored: (filePath) => isIgnoredWatchPath(opts.roots, filePath),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });
  watcher.on('all', fire);
  watcher.on('error', logWatchError);

  return {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close().catch(() => { /* */ });
    },
  };
}
