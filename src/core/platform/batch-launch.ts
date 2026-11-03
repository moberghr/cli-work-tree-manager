import fs from 'node:fs';
import path from 'node:path';
import { notOnPath, whereOnPath } from './program-path.js';

/**
 * Windows batch files (`.cmd` / `.bat`) as a CLI's launcher — the Azure CLI's
 * `az.cmd` is one. cmd.exe parses a batch file's arguments twice (the
 * `cmd /c` line, then `%*` inside the file), and cross-spawn escapes them for
 * only one parse: an argument with a double quote and `&` or `|` runs a
 * command of its own, `%VAR%` expands, and a line break ends the command
 * there (the arguments after it vanish). Measured with an `echo`-only batch
 * file. So, on Windows:
 *
 * - a batch file whose job is starting Python on a module (`"%~dp0\..\python.exe"
 *   -IBm azure.cli %*`, the Azure CLI's) is skipped: its Python is started
 *   directly, with the arguments as argv — no cmd.exe at all. Only that line
 *   is carried over: the file's other lines (az.cmd's `SET AZ_INSTALLER=MSI`,
 *   which only says how az was installed) don't run;
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

/** A batch file that runs `"%~dp0<rel>python.exe" <flags>m <module> %*`: that Python and its leading args. */
export function pythonShimOf(text: string, batchPath: string): { cmd: string; pre: string[] } | null {
  const m = /^\s*"%~dp0\\?([^"%]*python(?:w)?\.exe)"\s+(-[A-Za-z]*m)\s+([A-Za-z_][\w.]*)\s+%\*\s*$/im.exec(text);
  if (!m) return null;
  return { cmd: path.resolve(path.dirname(batchPath), m[1]), pre: [m[2], m[3]] };
}

/**
 * A batch file that starts a Node script with its arguments — npm's shims (`claude.cmd`: `"%_prog%"
 * "%dp0%\node_modules\…\cli.js" %*`, `%_prog%` being the node.exe beside it or `node`), or `node "%~dp0x.cjs" %*`:
 * the script, and the node.exe beside the shim it would prefer.
 */
export function nodeShimOf(text: string, batchPath: string): { script: string; localNode: string } | null {
  const m = /(?:"%_prog%"|\bnode(?:\.exe)?|"%(?:~dp0|dp0%)\\?node\.exe")\s+"%(?:~dp0|dp0%)\\?([^"%]+\.[cm]?js)"\s+%\*/i.exec(text);
  if (!m) return null;
  const dir = path.win32.dirname(batchPath);
  return { script: path.win32.resolve(dir, m[1]), localNode: path.win32.join(dir, 'node.exe') };
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

/**
 * What starts `cmd` on Windows: `file` with `pre` before the caller's arguments. `batch` when that is still a
 * batch file (cmd.exe will parse the arguments); a Python or Node shim is skipped for its interpreter. Null when
 * PATH has no such program. Looked up on PATH at every call — never the working folder (`whereOnPath`), never a
 * remembered miss.
 */
export type Program = { file: string; pre: string[]; batch: boolean };
export function programFor(cmd: string, io: LaunchIo = {}): Program | null {
  const env = io.env ?? process.env;
  const file = (io.find ?? whereOnPath)(cmd, env, 'win32');
  if (!file) return null;
  if (!/\.(cmd|bat)$/i.test(file)) return { file, pre: [], batch: false };
  const text = (io.read ?? readText)(file);
  const exists = io.exists ?? fs.existsSync;
  const py = text ? pythonShimOf(text, file) : null;
  if (py && exists(py.cmd)) return { file: py.cmd, pre: py.pre, batch: false };
  const js = text ? nodeShimOf(text, file) : null;
  if (js && exists(js.script)) {
    const node = exists(js.localNode) ? js.localNode : (whereOnPath('node', env, 'win32') ?? process.execPath);
    return { file: node, pre: [js.script], batch: false };
  }
  return { file, pre: [], batch: true };
}

/**
 * How to start `cmd` with `args` on Windows: by the absolute file PATH gives it — never the working folder
 * (`whereOnPath`, program-path.ts; not found: a path that fails as not installed) —, through its interpreter (a
 * Python module's or a Node script's batch shim), or refused (another batch file that would get cmd.exe's special
 * characters). Off Windows, as given.
 */
export function launchFor(cmd: string, args: string[], io: LaunchIo = {}): Launch {
  const platform = io.platform ?? process.platform;
  if (platform !== 'win32') return { cmd, args };
  const program = programFor(cmd, io);
  if (!program) return { cmd: notOnPath(cmd, io.env ?? process.env), args };
  if (!program.batch) return { cmd: program.file, args: [...program.pre, ...args] };
  const why = batchArgProblem(args);
  return why ? { refused: `${cmd}: ${why}` } : { cmd: program.file, args };
}
