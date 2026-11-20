import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config-dir.js';
import { resolveWorkBinPath } from './work-bin.js';

/**
 * How another program (Claude Code, for a hook or its status line) runs THIS work: never a bare `work`, which is
 * whatever the agent's PATH finds first. Reported: the desktop app's 2.11.3 wrote `work hook turn-end`, and a Claude
 * whose PATH had an old `npm link` first ran that build, which knew no `turn-end` and printed its usage as a hook error
 * on every turn.
 *
 * The desktop app runs work from a copy under `~/.work/runtime/<version>/`, which goes after an update: its launcher
 * (`~/.work/bin/work`, which runs `runtime/current`) is named instead on POSIX. Windows gets node and the script
 * (Claude Code runs hooks through Git Bash, which doesn't start a `.cmd`); the runtime the PTY host runs from stays
 * while it runs, and the file naming it is written again at each spawn.
 */
export interface WorkInvocationDeps {
  argv1?: string;
  execPath?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

/** The argv that runs this work: its launcher, or node and its `bin.js`. */
export function workInvocation(d: WorkInvocationDeps = {}): string[] {
  const platform = d.platform ?? process.platform;
  const configDir = d.configDir ?? getConfigDir();
  const exists = d.exists ?? fs.existsSync;
  const bin = resolveWorkBinPath(d.argv1 ?? process.argv[1] ?? '');
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const runtime = pathMod.join(configDir, 'runtime') + pathMod.sep;
  if (platform !== 'win32' && bin.startsWith(runtime)) {
    const launcher = pathMod.join(configDir, 'bin', 'work');
    if (exists(launcher)) return [launcher];
  }
  return [d.execPath ?? process.execPath, bin];
}

/** One word for sh (and Git Bash): single-quoted, forward slashes on Windows (a backslash is an escape there). */
export function shQuote(word: string, platform: NodeJS.Platform = process.platform): string {
  const w = platform === 'win32' ? word.replace(/\\/g, '/') : word;
  return /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** `work <args…>` as a shell command line that runs this work, whatever PATH says. */
export function workCommand(args: readonly string[], d: WorkInvocationDeps = {}): string {
  const platform = d.platform ?? process.platform;
  return [...workInvocation(d), ...args].map((w) => shQuote(w, platform)).join(' ');
}
