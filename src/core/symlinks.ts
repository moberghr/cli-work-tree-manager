import fs from 'node:fs';
import path from 'node:path';
import { debugLog } from './logger.js';

/**
 * Symlink shared cache directories (e.g. node_modules, .venv, target) from the
 * source repo into a freshly-created worktree so it skips a cold re-install.
 *
 * For each name:
 *  - skip if the destination already exists (lstat-style existsSync catches symlinks too),
 *  - skip if the source does not exist,
 *  - otherwise create a directory symlink.
 *
 * Never throws — failures are logged as warnings and skipped.
 */
export function setupSharedCaches(
  repoPath: string,
  worktreePath: string,
  names: string[],
): void {
  for (const name of names) {
    const source = path.join(repoPath, name);
    const dest = path.join(worktreePath, name);

    try {
      // existsSync follows the same realpath rules and reports true for an
      // existing symlink at dest as well, so we never clobber anything.
      if (fs.existsSync(dest)) {
        continue;
      }
      if (!fs.existsSync(source)) {
        continue;
      }
      fs.symlinkSync(source, dest, 'dir');
      console.log(`  Linked cache: ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Skipped shared cache "${name}": ${msg}`);
      debugLog('WARN', `setupSharedCaches failed for ${name}: ${msg}`);
    }
  }
}
