import fs from 'node:fs';
import path from 'node:path';

/** The file system calls this needs (tests pass a fake one). */
export interface ModeFs {
  statSync(p: string): { mode: number };
  chmodSync(p: string, mode: number): void;
}

export interface SpawnHelperCheck {
  /** Made executable. */
  fixed: string[];
  /** Not executable, and chmod failed (a root-owned global install): terminals can't start. */
  failed: Array<{ file: string; error: string }>;
}

/**
 * node-pty starts every terminal on macOS and Linux through its
 * `spawn-helper`. Its npm package ships the prebuilt one without the
 * executable bit, and its install script — which would fix that — doesn't
 * always run (npm skipping dependency install scripts; the desktop app's
 * 2.0.2 shipped it 0644): every terminal then fails with "posix_spawnp
 * failed". Make it executable where it lies: the prebuild for this
 * platform, and a locally built one. Nothing on Windows.
 */
export function makeSpawnHelperExecutable(
  ptyDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  f: ModeFs = fs,
): SpawnHelperCheck {
  const out: SpawnHelperCheck = { fixed: [], failed: [] };
  if (platform === 'win32') return out;
  for (const file of [
    path.join(ptyDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(ptyDir, 'build', 'Release', 'spawn-helper'),
  ]) {
    let mode: number;
    try {
      mode = f.statSync(file).mode;
    } catch {
      continue; // not there: the other one is used
    }
    if ((mode & 0o111) === 0o111) continue;
    try {
      f.chmodSync(file, (mode & 0o777) | 0o755);
      out.fixed.push(file);
    } catch (err) {
      out.failed.push({ file, error: (err as Error).message });
    }
  }
  return out;
}
