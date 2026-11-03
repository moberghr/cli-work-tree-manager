import path from 'node:path';
import { findOnPath, isProgramFile } from './find-on-path.js';

/**
 * The program a bare command name starts, from PATH only — never the working folder.
 *
 * On Windows every way of starting a program by its bare name looks in the working folder first:
 * cross-spawn's lookup (node-which "always checks the cwd first", after a `chdir` into the spawn's
 * cwd), libuv's own (`execFile('git', …, {cwd})`) and cmd.exe's. work runs git, gh, az and acli with
 * the cwd in a worktree — someone else's branch too (Review, Work on it) — so a `git.cmd`, `gh.cmd` or
 * `git.exe` committed at its root ran in place of the real tool (measured with an echo-only file).
 * So on Windows a bare name is resolved here to the absolute file on PATH (absolute PATH entries
 * only: a relative one is the working folder again) and that path is what's started. App Execution
 * Aliases (`wt.exe`, `winget`, the Store's `python`) count: `stat` can't read them, Windows starts
 * them (`isProgramFile`). Not found: a path that doesn't exist, so the start fails as "not installed"
 * (ENOENT, said as "<name> not found on PATH": `explainNotOnPath`) and nothing from the working folder
 * runs. A name with a path in it (`./x`, `C:\npm\claude`) is resolved as Windows itself would — against
 * the start's working folder, with PATHEXT's extensions when it has none (`C:\npm\claude` is
 * `claude.cmd` beside it) — so what is judged (a batch file or not) is the file that really starts.
 * Off Windows everything is left as given (a POSIX lookup never takes the working folder unless PATH
 * says so).
 */

/** Hits per name + PATH + PATHEXT, checked to still be there on use; a miss is never kept (a tool installed later is found). */
const hits = new Map<string, string>();

/** Whether `cmd` names a path rather than a program to look up. */
const isPathLike = (cmd: string) => /[\\/]/.test(cmd) || path.win32.isAbsolute(cmd) || /^[A-Za-z]:/.test(cmd);

/**
 * The absolute file PATH gives `cmd` on Windows (absolute PATH entries only), or null; `cmd` as given anywhere else.
 * A path is resolved against `cwd` (the start's working folder; this process's when not given) with PATHEXT's
 * extensions; one that doesn't resolve is returned as given (its start fails as not found by itself).
 */
export function whereOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): string | null {
  if (platform !== 'win32') return cmd;
  const pathExt = env.PATHEXT ?? env.Pathext;
  const extEnv = pathExt !== undefined ? { PATHEXT: pathExt } : {};
  if (isPathLike(cmd)) {
    const full = path.win32.resolve(cwd ?? process.cwd(), cmd);
    return findOnPath(full, extEnv, 'win32') ?? cmd;
  }
  const rawPath = env.PATH ?? env.Path ?? '';
  const key = `${cmd.toLowerCase()}\0${rawPath}\0${pathExt ?? ''}`;
  const cached = hits.get(key);
  if (cached && isProgramFile(cached, 'win32')) return cached;
  hits.delete(key);
  const absolute = rawPath
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && path.win32.isAbsolute(d) && !/^[\\/](?![\\/])/.test(d))
    .join(';');
  const found = findOnPath(cmd, { PATH: absolute, ...extEnv }, 'win32');
  if (found) hits.set(key, found);
  return found;
}

/** The folder the stand-in for a program that isn't on PATH is in (never created). */
const STAND_IN_DIR = 'work-not-on-path';

/** Where a program that isn't on PATH is "started" from: a folder that isn't there, so the start fails as not found. */
export function notOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', STAND_IN_DIR, cmd);
}

/** The program name a `notOnPath` stand-in stands for, or null when `file` isn't one. */
export function standInFor(file: string): string | null {
  const m = /[\\/]work-not-on-path[\\/]([^\\/]+)$/i.exec(file);
  return m ? m[1] : null;
}

/**
 * A start's error that came from a `notOnPath` stand-in, said in the program's own name: "winget not found on PATH"
 * rather than "spawn C:\Windows\work-not-on-path\winget ENOENT" (the stand-in is work's device, not a place to
 * look). The code stays ENOENT, so callers that tell "not installed" by it still do. Changes the error in place;
 * returns it.
 */
export function explainNotOnPath<T>(err: T): T {
  if (!(err instanceof Error)) return err;
  const e = err as NodeJS.ErrnoException;
  const name = (typeof e.path === 'string' ? standInFor(e.path) : null) ?? /[\\/]work-not-on-path[\\/]([^\s\\/]+)/i.exec(e.message)?.[1];
  if (!name) return err;
  e.message = `${name} not found on PATH`;
  e.path = name;
  return err;
}

/** What to start for `cmd`: its absolute file on PATH (Windows), a path that fails as not found when it isn't there, `cmd` elsewhere. */
export function programPath(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): string {
  return whereOnPath(cmd, env, platform, cwd) ?? notOnPath(cmd, env);
}
