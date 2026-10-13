import fs from 'node:fs';
import path from 'node:path';

/**
 * The file a command name runs, as a shell finds it: a path is itself, else the
 * first match in PATH (on Windows each PATHEXT extension too: `claude` is
 * `claude.exe` or `claude.cmd`). Null when there's none.
 */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const win = platform === 'win32';
  const exts = win ? ['', ...(env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const candidates = (base: string) => exts.map((e) => base + e.toLowerCase());
  if (cmd.includes('/') || (win && cmd.includes('\\'))) return candidates(cmd).find(isFile) ?? null;
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(path.join(dir, cmd)).find(isFile);
    if (hit) return hit;
  }
  return null;
}
