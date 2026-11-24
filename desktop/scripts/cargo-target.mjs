// One Cargo target folder for every worktree of this repository. Cargo builds
// into desktop/src-tauri/target of whichever checkout it runs in, so the dev
// app in a new worktree compiled all ~390 crates again; pointed at the main
// checkout's folder, a worktree compiles only the app's own crate.
//
// What sharing costs: Cargo locks the folder, so two worktrees building at
// once take turns, and each build replaces the same target/debug/work-desktop
// (on Windows that fails while another worktree's dev app runs it; set
// CARGO_TARGET_DIR yourself to keep one apart).

import path from 'node:path';

/**
 * The folder the dev app's Cargo build should use, or null to leave Cargo's
 * own choice: the user's CARGO_TARGET_DIR wins, the main checkout builds
 * where it always did, and a checkout whose main one can't be told (no git,
 * a bare repository) is left alone.
 *
 * @param {string} root this checkout
 * @param {string | null} gitCommonDir `git rev-parse --path-format=absolute --git-common-dir` there, or null when that failed
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function sharedCargoTarget(root, gitCommonDir, env) {
  if (Object.keys(env).some((k) => k.toUpperCase() === 'CARGO_TARGET_DIR' && env[k])) return null;
  if (!gitCommonDir || path.basename(gitCommonDir) !== '.git') return null;
  const main = path.dirname(gitCommonDir);
  if (path.relative(main, root) === '') return null;
  return path.join(main, 'desktop', 'src-tauri', 'target');
}
