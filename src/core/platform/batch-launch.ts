import fs from 'node:fs';
import path from 'node:path';
import { findOnPath } from './find-on-path.js';

/**
 * Windows batch files (`.cmd` / `.bat`) as a CLI's launcher — the Azure CLI's
 * `az.cmd` is one. cmd.exe parses a batch file's arguments twice (the
 * `cmd /c` line, then `%*` inside the file), and cross-spawn escapes them for
 * only one parse: an argument with a double quote and `&` or `|` runs a
 * command of its own, `%VAR%` expands, and a line break ends the command
 * there (the arguments after it vanish). Measured with an `echo`-only batch
 * file. So, on Windows:
 *
 * - a batch file that only starts Python on a module (`"%~dp0\..\python.exe"
 *   -IBm azure.cli %*`, the Azure CLI's) is skipped: its Python is started
 *   directly, with the arguments as argv — no cmd.exe at all;
 * - any other batch file gets only arguments with none of cmd's special
 *   characters: the run is refused, never sent half-escaped.
 */

/** cmd.exe's special characters, and what cuts a command line short. */
const BATCH_UNSAFE = /["%^&|<>!()\r\n\0]/;

/** Why these arguments can't go through a batch file (null: they can). */
export function batchArgProblem(args: readonly string[]): string | null {
  const bad = args.find((a) => BATCH_UNSAFE.test(a));
  if (bad === undefined) return null;
  const ch = BATCH_UNSAFE.exec(bad)![0];
  const shown = ch === '\r' ? 'a line break (CR)' : ch === '\n' ? 'a line break' : ch === '\0' ? 'a NUL' : `"${ch}"`;
  return `refused: an argument has ${shown}, which a Windows batch file can't be given safely`;
}

/** A batch file that only runs `"%~dp0<rel>python.exe" <flags>m <module> %*`: that Python and its leading args. */
export function pythonShimOf(text: string, batchPath: string): { cmd: string; pre: string[] } | null {
  const m = /^\s*"%~dp0\\?([^"%]*python(?:w)?\.exe)"\s+(-[A-Za-z]*m)\s+([A-Za-z_][\w.]*)\s+%\*\s*$/im.exec(text);
  if (!m) return null;
  return { cmd: path.resolve(path.dirname(batchPath), m[1]), pre: [m[2], m[3]] };
}

export type Launch = { cmd: string; args: string[] } | { refused: string };

interface LaunchIo {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  find?: (cmd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | null;
  read?: (file: string) => string | null;
  exists?: (file: string) => boolean;
}

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Per command and PATH: what it resolves to (PATH changes when work web adds the login shell's). */
const cache = new Map<string, { batch: string | null; shim: { cmd: string; pre: string[] } | null }>();

/**
 * How to start `cmd` with `args`: as given (not Windows, or not a batch file), through its Python (a Python
 * module's batch shim), or refused (a batch file that would get cmd.exe's special characters).
 */
export function launchFor(cmd: string, args: string[], io: LaunchIo = {}): Launch {
  const platform = io.platform ?? process.platform;
  if (platform !== 'win32') return { cmd, args };
  const env = io.env ?? process.env;
  const key = `${cmd}\0${env.PATH ?? env.Path ?? ''}`;
  let hit = io.find || io.read || io.exists ? undefined : cache.get(key);
  if (!hit) {
    const file = (io.find ?? findOnPath)(cmd, env, platform);
    const batch = file && /\.(cmd|bat)$/i.test(file) ? file : null;
    let shim: { cmd: string; pre: string[] } | null = null;
    if (batch) {
      const text = (io.read ?? readText)(batch);
      const found = text ? pythonShimOf(text, batch) : null;
      if (found && (io.exists ?? fs.existsSync)(found.cmd)) shim = found;
    }
    hit = { batch, shim };
    if (!(io.find || io.read || io.exists)) cache.set(key, hit);
  }
  if (!hit.batch) return { cmd, args };
  if (hit.shim) return { cmd: hit.shim.cmd, args: [...hit.shim.pre, ...args] };
  const why = batchArgProblem(args);
  return why ? { refused: `${cmd}: ${why}` } : { cmd, args };
}
