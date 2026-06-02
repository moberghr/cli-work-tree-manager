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
 * Debounced chokidar watcher over one-or-more repo roots. Filters out
 * `.git/` to avoid the constant noise git generates internally. Shared
 * between `wd` (the diff server's reload trigger) and any other live
 * file-watcher need.
 */
export function createFsWatcher(opts: FsWatcherOptions): FsWatcher {
  const debounceMs = opts.debounceMs ?? 150;
  let debounceTimer: NodeJS.Timeout | null = null;

  const watcher = chokidar.watch(opts.roots, {
    ignored: (filePath) => {
      for (const root of opts.roots) {
        const rel = path.relative(root, filePath).replace(/\\/g, '/');
        if (rel === '.git' || rel.startsWith('.git/')) return true;
      }
      return false;
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });

  watcher.on('all', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      opts.onChange();
    }, debounceMs);
  });
  watcher.on('error', (err) => {
    process.stderr.write(
      chalk.yellow('[watcher] fs error: ') + (err as Error).message + '\n',
    );
  });

  return {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close().catch(() => { /* */ });
    },
  };
}
