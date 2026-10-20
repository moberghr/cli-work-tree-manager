import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import path from 'node:path';
import { findOnPath } from './find-on-path.js';
import { report } from './report.js';
import { debugLog } from './logger.js';
import { detachHere } from './process.js';

/**
 * The PATH of the user's login shell, for a work started without one.
 *
 * Reported from a Mac: every session ended at once with "session exited with code 1", and Enter
 * gave the same. The desktop app started from the Dock or Finder gets the system's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), not the one the user's shell sets up, and passes it on to work
 * web, the PTY host and every Claude: `claude` (in ~/.local/bin, /opt/homebrew/bin, an nvm folder…)
 * isn't found, and node-pty's child exits with 1 when its exec fails. So when work web or the PTY
 * host starts on macOS or Linux and the agent's command isn't on its PATH, it asks the login shell
 * for its PATH (`$SHELL -ilc`, as a terminal would set it up) and puts it first. Started from a
 * terminal, the command is found and nothing is asked.
 */

const MARK = '__WORK_SHELL_PATH__';

/** The shell's PATH first, then what we had that it lacks (e.g. the app's ~/.work/bin). */
export function mergePath(current: string | undefined, shellPath: string, sep = path.delimiter): string {
  const out: string[] = [];
  for (const d of [...shellPath.split(sep), ...(current ?? '').split(sep)]) if (d && !out.includes(d)) out.push(d);
  return out.join(sep);
}

/** The PATH between the markers of the shell's output (an interactive shell may print a greeting around it). */
export function parseShellPath(stdout: string): string | null {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(stdout);
  const p = m?.[1].trim();
  return p ? p : null;
}

/** How long the login shell may take to say its PATH. */
export const SHELL_PATH_TIMEOUT_MS = 5_000;

/** The shell's arguments: a login, interactive shell (what a terminal runs) printing its PATH between markers. */
export const shellPathArgs = (): string[] => ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`];

/**
 * How it's started. `killSignal: SIGKILL`: an interactive bash or zsh ignores SIGTERM (spawnSync's
 * default at the timeout), and Node then waits for it — a stuck profile held work web up for as long as
 * it hung (reproduced: a 2 s timeout returned after 8 s). `detached` (POSIX): its own session, so it
 * never takes this terminal's foreground group — killed while holding it, it left `work web` in the
 * background, where Ctrl+C no longer reached it (reproduced).
 */
export const shellPathSpawnOptions = (timeoutMs = SHELL_PATH_TIMEOUT_MS): SpawnSyncOptionsWithStringEncoding =>
  // `detached` isn't in @types/node's spawnSync options, but spawnSync honors it (spawn_sync reads it).
  ({
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    detached: detachHere(),
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }) as SpawnSyncOptionsWithStringEncoding;

type ShellRun = (cmd: string, args: string[]) => { stdout?: string | null; status?: number | null; signal?: string | null; error?: Error };

/** Ask the login shell for its PATH: its PATH, or why it couldn't say (a timeout, no such shell, no markers). */
export function readShellPath(
  shell = process.env.SHELL || '/bin/zsh',
  run: ShellRun = (cmd, args) => spawnSync(cmd, args, shellPathSpawnOptions()),
): { path: string } | { why: string } {
  try {
    const r = run(shell, shellPathArgs());
    const p = parseShellPath(r.stdout ?? '');
    if (p) return { path: p };
    const how = r.error
      ? r.error.message
      : r.signal
        ? `stopped by ${r.signal} (over ${SHELL_PATH_TIMEOUT_MS / 1000} s?)`
        : `exit ${r.status ?? '?'}, no PATH printed`;
    return { why: `${shell} -ilc: ${how}` };
  } catch (err) {
    return { why: `${shell} -ilc: ${(err as Error).message}` };
  }
}

/**
 * Make sure the commands in `need` (the agent's binary) can be found: on macOS and Linux, when one
 * isn't on PATH, the login shell's PATH is merged into this process's (which everything it starts
 * inherits). Says what it did; never throws.
 */
export function ensureShellPath(
  need: string[],
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    readPath?: () => { path: string } | { why: string };
    find?: (cmd: string, env: NodeJS.ProcessEnv) => string | null;
  } = {},
): 'found' | 'added' | 'unavailable' {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') return 'found';
  const find = opts.find ?? ((c: string, e: NodeJS.ProcessEnv) => findOnPath(c, e, platform));
  const missing = need.filter((c) => !find(c, env));
  if (!missing.length) return 'found';
  // Said in the debug log too: started by the desktop app, nothing shows what a reporter prints.
  const say = (level: 'info' | 'warn', text: string) => {
    report(level, text);
    debugLog(level === 'warn' ? 'WARN' : 'INFO', text);
  };
  const read = (opts.readPath ?? (() => readShellPath(env.SHELL)))();
  if ('why' in read) {
    say('warn', `${missing.join(', ')} isn't on PATH (${env.PATH ?? ''}), and the login shell's PATH couldn't be read: ${read.why}`);
    return 'unavailable';
  }
  env.PATH = mergePath(env.PATH, read.path);
  const still = missing.filter((c) => !find(c, env));
  say(
    still.length ? 'warn' : 'info',
    still.length
      ? `${still.join(', ')} isn't on PATH, even with the login shell's (${env.PATH})`
      : `${missing.join(', ')} found with the login shell's PATH: using it (${env.PATH})`,
  );
  return 'added';
}
