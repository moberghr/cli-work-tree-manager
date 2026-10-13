import fs from 'node:fs';
import path from 'node:path';

/**
 * The file a command name runs, as a shell finds it: a path is itself, else the
 * first match in PATH. On Windows a name without one of PATHEXT's extensions is
 * tried with each (`claude` is `claude.exe` or `claude.cmd`; npm's extension-less
 * `claude` sh shim beside them is never run); elsewhere only an executable file
 * counts. Null when there's none.
 */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const win = platform === 'win32';
  const isFile = (p: string) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() && (win || (st.mode & 0o111) !== 0);
    } catch {
      return false;
    }
  };
  const pathExt = (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((e) => e.toLowerCase());
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
