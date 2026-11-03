import fs from 'node:fs';
import path from 'node:path';
import { findOnPath } from './find-on-path.js';

/**
 * The program a bare command name starts, from PATH only — never the working folder.
 *
 * On Windows every way of starting a program by its bare name looks in the working folder first:
 * cross-spawn's lookup (node-which "always checks the cwd first", after a `chdir` into the spawn's
 * cwd), libuv's own (`execFile('git', …, {cwd})`) and cmd.exe's. work runs git, gh, az and acli with
 * the cwd in a worktree — someone else's branch too (Review, Work on it) — so a `git.cmd`, `gh.cmd` or
 * `git.exe` committed at its root ran in place of the real tool (measured with an echo-only file).
 * So on Windows a bare name is resolved here to the absolute file on PATH (absolute PATH entries
 * only: a relative one is the working folder again) and that path is what's started. Not found: a
 * path that doesn't exist, so the start fails as "not installed" (ENOENT) and nothing from the
 * working folder runs. A name with a path in it (`./x`, `C:\x\y.exe`) is the caller's and is left
 * as it is, as is everything off Windows (a POSIX lookup never takes the working folder unless PATH
 * says so).
 */

/** Hits per name + PATH + PATHEXT, checked to still be there on use; a miss is never kept (a tool installed later is found). */
const hits = new Map<string, string>();

const isFile = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The absolute file PATH gives `cmd` on Windows (absolute PATH entries only), or null; `cmd` as given anywhere else. */
export function whereOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return cmd;
  if (/[\\/]/.test(cmd) || path.win32.isAbsolute(cmd)) return cmd;
  const rawPath = env.PATH ?? env.Path ?? '';
  const pathExt = env.PATHEXT ?? env.Pathext;
  const key = `${cmd.toLowerCase()}\0${rawPath}\0${pathExt ?? ''}`;
  const cached = hits.get(key);
  if (cached && isFile(cached)) return cached;
  hits.delete(key);
  const absolute = rawPath
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && path.win32.isAbsolute(d) && !/^[\\/](?![\\/])/.test(d))
    .join(';');
  const found = findOnPath(cmd, { PATH: absolute, ...(pathExt !== undefined ? { PATHEXT: pathExt } : {}) }, 'win32');
  if (found) hits.set(key, found);
  return found;
}

/** Where a program that isn't on PATH is "started" from: a folder that isn't there, so the start fails as not found. */
export function notOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'work-not-on-path', cmd);
}

/** What to start for `cmd`: its absolute file on PATH (Windows), a path that fails as not found when it isn't there, `cmd` elsewhere. */
export function programPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return whereOnPath(cmd, env, platform) ?? notOnPath(cmd, env);
}
