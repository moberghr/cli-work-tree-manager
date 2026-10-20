import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { findOnPath } from './find-on-path.js';
import { report } from './report.js';
import { getAiTool } from './ai-launcher.js';
import { loadConfig, type WorkConfig } from './config.js';

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

/** Ask the login shell for its PATH; null when it can't say within a few seconds. */
export function readShellPath(
  shell = process.env.SHELL || '/bin/zsh',
  run: (cmd: string, args: string[]) => { stdout?: string | null } = (cmd, args) =>
    spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
): string | null {
  try {
    return parseShellPath(run(shell, ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`]).stdout ?? '');
  } catch {
    return null;
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
    readPath?: () => string | null;
    find?: (cmd: string, env: NodeJS.ProcessEnv) => string | null;
  } = {},
): 'found' | 'added' | 'unavailable' {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') return 'found';
  const find = opts.find ?? ((c: string, e: NodeJS.ProcessEnv) => findOnPath(c, e, platform));
  const missing = need.filter((c) => !find(c, env));
  if (!missing.length) return 'found';
  const shellPath = (opts.readPath ?? (() => readShellPath(env.SHELL)))();
  if (!shellPath) {
    report('warn', `${missing.join(', ')} isn't on PATH (${env.PATH ?? ''}), and the login shell's PATH couldn't be read`);
    return 'unavailable';
  }
  env.PATH = mergePath(env.PATH, shellPath);
  const still = missing.filter((c) => !find(c, env));
  report(
    still.length ? 'warn' : 'info',
    still.length
      ? `${still.join(', ')} isn't on PATH, even with the login shell's (${env.PATH})`
      : `${missing.join(', ')} found with the login shell's PATH: using it (${env.PATH})`,
  );
  return 'added';
}

/** The commands work starts agents with: the configured one, and `claude` (the Ctrl+K assistant's, work's summaries). */
export function agentCommands(config: Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null): string[] {
  return [...new Set([getAiTool(config ?? {}).cmd, 'claude'])];
}

/** For `work web` and the PTY host as they start: find the agents' commands, with the login shell's PATH if need be. */
export function ensureAgentPath(): void {
  try {
    ensureShellPath(agentCommands(loadConfig()));
  } catch {
    /* best effort: a session then says what it can't start */
  }
}
