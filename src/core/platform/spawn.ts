import { createRequire } from 'node:module';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
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
 * cwd, as cross-spawn would. A `shell: true` command line is the caller's own: left as it is, run
 * with cmd.exe's lookup in the working folder turned off (`shellEnv`, shell-env.ts). A program
 * that isn't on PATH fails as "<name> not found on PATH" (`explainNotOnPath`).
 */
type CrossSpawn = typeof CrossSpawnModule;

let loaded: CrossSpawn | null = null;
const load = (): CrossSpawn => (loaded ??= createRequire(import.meta.url)('cross-spawn') as CrossSpawn);

type Options = { env?: NodeJS.ProcessEnv; shell?: unknown; cwd?: unknown };

/** The call's arguments with its program resolved from PATH (Windows; see above). */
export function onPathOnly(args: unknown[], platform: NodeJS.Platform = process.platform): unknown[] {
  const [cmd, second, third] = args;
  if (platform !== 'win32' || typeof cmd !== 'string') return args;
  const at = Array.isArray(second) ? 2 : 1;
  const options = (at === 2 ? third : second) as Options | undefined;
  if (options?.shell) {
    const out = [...args];
    out[at] = { ...options, env: shellEnv(options.env ?? process.env, platform) };
    return out;
  }
  const cwd = typeof options?.cwd === 'string' ? options.cwd : undefined;
  return [programPath(cmd, options?.env ?? process.env, platform, cwd), ...args.slice(1)];
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
) as unknown as CrossSpawn;

export default spawn;
