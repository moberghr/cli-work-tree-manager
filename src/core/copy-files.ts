import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import chalk from 'chalk';

/** Directories to exclude when copying files. */
const EXCLUDED_DIRS = ['bin', 'obj', 'node_modules', '.git'];

/**
 * Copy files matching configured patterns from a source repo into a worktree.
 * Handles .claude directory specially (direct path match).
 * Other patterns use recursive glob with exclusion filtering.
 */
export function copyConfigFiles(
  repoPath: string,
  worktreePath: string,
  patterns: string[],
): void {
  for (const pattern of patterns) {
    // Normalize pattern separators to forward slashes for glob
    const normalized = pattern.replace(/\\/g, '/');

    // Handle .claude directory specially (direct path match)
    if (normalized.startsWith('.claude/')) {
      const relativePath = normalized;
      const sourcePath = path.join(repoPath, relativePath);

      if (fs.existsSync(sourcePath)) {
        const destPath = path.join(worktreePath, relativePath);
        const destDir = path.dirname(destPath);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(sourcePath, destPath);
        console.log(`  Copied: ${relativePath}`);
      }
      continue;
    }

    // Use glob for pattern matching (recursive)
    const matches = globSync(`**/${normalized}`, {
      cwd: repoPath,
      nodir: true,
      posix: true,
    });

    for (const match of matches) {
      // Check exclusion directories
      const parts = match.split('/');
      if (parts.some((p) => EXCLUDED_DIRS.includes(p))) {
        continue;
      }

      const sourcePath = path.join(repoPath, match);
      const destPath = path.join(worktreePath, match);
      const destDir = path.dirname(destPath);

      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(sourcePath, destPath);
      console.log(`  Copied: ${match}`);
    }
  }
}
