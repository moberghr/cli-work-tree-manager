import { launchFor } from './batch-launch.js';
import crossSpawn from './spawn.js';

/**
 * How work runs a CLI (git, a git host's CLI, acli) for a decision it makes:
 * argv only, never a shell (§1.1), injectable so the decision logic is
 * unit-testable. Moved from core/pr/ship.ts, which re-exports it.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** `env`: variables set for this run, over the process's own (a runner that can't set them ignores them). */
export type CommandRunner = (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<RunResult>;

/** The exit code a run that timed out reports (as coreutils' `timeout` does): what it was doing may have happened. */
export const RUN_TIMED_OUT = 124;

/**
 * Real runner: cross-spawn, not execFile — on Windows execFile only finds
 * .exe files, so a `gh` installed as a .cmd shim (scoop, wrappers) would
 * look "not installed"; cross-spawn resolves shims like `work tree` does,
 * with cmd-escaped args. Exit code 127 = the binary itself is missing.
 * On Windows it starts what `launchFor` (batch-launch.ts) resolved — the
 * absolute file on PATH, never the bare name (cross-spawn would look that up
 * again, the working folder first: a worktree's own `git.cmd` would run) —
 * and a batch file is never handed cmd.exe's special characters: a Python
 * or Node shim (`az.cmd`, npm's) is skipped for its interpreter, any other
 * refuses such an argument (exit 1, said why).
 */
export const defaultRunner: CommandRunner = (cmd, args, cwd, env) =>
  new Promise((resolve) => {
    const launch = launchFor(cmd, args);
    if ('refused' in launch) {
      resolve({ code: 1, stdout: '', stderr: launch.refused });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = crossSpawn(launch.cmd, launch.args, { cwd, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
    const timer = setTimeout(() => {
      child.kill();
      done({ code: RUN_TIMED_OUT, stdout, stderr: stderr || `${cmd} timed out` });
    }, 60_000);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      done({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: err.message });
    });
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
