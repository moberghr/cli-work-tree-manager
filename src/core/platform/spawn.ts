import { createRequire } from 'node:module';
import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import type CrossSpawnModule from 'cross-spawn';
import { explainNotOnPath, programPath } from './program-path.js';
import { shellEnv } from './shell-env.js';

/**
 * cross-spawn, loaded on first use. core's modules all spawn through it, and
 * importing it up front put it (and its dependencies) on every `work hook`
 * — which runs twice per turn of every Claude — whether the hook spawned
 * anything or not. Same function, same `.sync`.
 *
 * On Windows a bare program name is started by its absolute path on PATH, never from the working
 * folder (`programPath`, program-path.ts): cross-spawn's lookup checks the spawn's cwd first, and a
 * `git.cmd` at a worktree's root would run in place of git. A path is resolved against the call's
 * cwd, as cross-spawn would. A program that resolves to a batch file runs in cmd.exe, so it gets `shellEnv` too
 * (a bare name inside it isn't looked up in the working folder). A `shell: true` command line is the caller's own: left as it is, run
 * with cmd.exe's lookup in the working folder turned off (`shellEnv`, shell-env.ts). A program
 * that isn't on PATH fails as "<name> not found on PATH" (`explainNotOnPath`).
 *
 * `keepCwdLookup: true` (work's own option, taken off before cross-spawn sees the call) leaves `shellEnv` out: for
 * long-lived interactive programs the user works in — an editor, a terminal, the browser — whose own terminals and
 * tasks would otherwise inherit the switch (shell-env.ts). Tool runs (the CommandRunner, agents, hooks, `work run`,
 * a dev server) never pass it.
 */
type CrossSpawn = typeof CrossSpawnModule;

let loaded: CrossSpawn | null = null;
const load = (): CrossSpawn => (loaded ??= createRequire(import.meta.url)('cross-spawn') as CrossSpawn);

type Options = { env?: NodeJS.ProcessEnv; shell?: unknown; cwd?: unknown; keepCwdLookup?: unknown };

/** The spawn wrapper's own option (see above). */
export interface KeepCwdLookup {
  keepCwdLookup?: boolean;
}

/** What Windows starts through cmd.exe: a `.cmd` or `.bat` file. */
export const BATCH_FILE = /\.(cmd|bat)$/i;

/** The call's arguments with its program resolved from PATH (Windows; see above). */
export function onPathOnly(args: unknown[], platform: NodeJS.Platform = process.platform): unknown[] {
  const [cmd, second, third] = args;
  const at = Array.isArray(second) ? 2 : 1;
  const given = (at === 2 ? third : second) as Options | undefined;
  if (given && 'keepCwdLookup' in given) {
    // Taken off on every platform: cross-spawn and node never see it.
    const { keepCwdLookup, ...rest } = given;
    args = [...args];
    args[at] = rest;
    if (keepCwdLookup === true) {
      if (platform !== 'win32' || typeof cmd !== 'string') return args;
      const cwd = typeof rest.cwd === 'string' ? rest.cwd : undefined;
      return [programPath(cmd, rest.env ?? process.env, platform, cwd), ...args.slice(1)];
    }
  }
  if (platform !== 'win32' || typeof cmd !== 'string') return args;
  const options = (at === 2 ? args[2] : args[1]) as Options | undefined;
  if (options?.shell) {
    const out = [...args];
    out[at] = { ...options, env: shellEnv(options.env ?? process.env, platform) };
    return out;
  }
  const cwd = typeof options?.cwd === 'string' ? options.cwd : undefined;
  const file = programPath(cmd, options?.env ?? process.env, platform, cwd);
  const out = [file, ...args.slice(1)];
  // A batch file is run by cmd.exe (cross-spawn's `cmd.exe /d /s /c`), and a bare name inside it would be looked up
  // in the working folder first — a worktree's own `probex.bat` in place of the program the batch file means.
  if (BATCH_FILE.test(file)) out[at] = { ...(options ?? {}), env: shellEnv(options?.env ?? process.env, platform) };
  return out;
}

const spawn = Object.assign(
  (...args: unknown[]) => {
    const child = (load() as unknown as (...a: unknown[]) => ChildProcess)(...onPathOnly(args));
    // First, so every listener sees the program's name rather than the stand-in path.
    child.prependListener?.('error', (err) => explainNotOnPath(err));
    return child;
  },
  {
    sync: (...args: unknown[]) => {
      const r = (load().sync as unknown as (...a: unknown[]) => SpawnSyncReturns<unknown>)(...onPathOnly(args));
      if (r?.error) explainNotOnPath(r.error);
      return r;
    },
  },
) as unknown as WorkSpawn;

/** cross-spawn's type, plus `keepCwdLookup` on a call with options. */
type WorkSpawn = CrossSpawn & {
  (command: string, args: readonly string[], options: SpawnOptions & KeepCwdLookup): ChildProcess;
  sync: CrossSpawn['sync'] &
    ((command: string, args: readonly string[], options: SpawnSyncOptions & KeepCwdLookup) => SpawnSyncReturns<Buffer>);
};

export default spawn;
