import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether `p` is a program file. Elsewhere than Windows: a file with an executable bit. On Windows: a file — or
 * an App Execution Alias, which `stat` can't read: the stubs in `%LOCALAPPDATA%\Microsoft\WindowsApps` (`wt.exe`,
 * `winget.exe`, the Store's `python.exe` and `pwsh.exe`) are reparse points that `stat` answers EACCES for, while
 * `lstat` sees them (as a link). Windows starts them; counting them missing made Windows Terminal look not
 * installed. So on Windows a hit whose `stat` fails but whose `lstat` is there and not a folder counts.
 */
export function isProgramFile(p: string, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32';
  try {
    const st = fs.statSync(p);
    return st.isFile() && (win || (st.mode & 0o111) !== 0);
  } catch {
    if (!win) return false;
    try {
      return !fs.lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  }
}

/** PATHEXT's extensions, lower-cased (Windows' default when unset). */
export function pathExtOf(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

/**
 * The file a command name runs, as a shell finds it: a path is itself, else the
 * first match in PATH. On Windows a name without one of PATHEXT's extensions is
 * tried with each (`claude` is `claude.exe` or `claude.cmd`; npm's extension-less
 * `claude` sh shim beside them is never run) — a path too (`C:\npm\claude` starts
 * `C:\npm\claude.cmd`, as Windows and cross-spawn would); elsewhere only an
 * executable file counts. Null when there's none.
 */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const win = platform === 'win32';
  const isFile = (p: string) => isProgramFile(p, platform);
  const pathExt = pathExtOf(env);
  const hasExt = pathExt.includes(path.extname(cmd).toLowerCase());
  const candidates = (base: string) => (!win || hasExt ? [base] : pathExt.map((e) => base + e));
  if (cmd.includes('/') || (win && cmd.includes('\\'))) return candidates(cmd).find(isFile) ?? null;
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(path.join(dir, cmd)).find(isFile);
    if (hit) return hit;
  }
  return null;
}
