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
export type CommandRunner = (cmd: string, args: string[], cwd: string) => Promise<RunResult>;

/**
 * Real runner: cross-spawn, not execFile — on Windows execFile only finds
 * .exe files, so a `gh` installed as a .cmd shim (scoop, wrappers) would
 * look "not installed"; cross-spawn resolves shims like `work tree` does,
 * with cmd-escaped args. Exit code 127 = the binary itself is missing.
 */
export const defaultRunner: CommandRunner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = crossSpawn(cmd, args, { cwd, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done({ code: 124, stdout, stderr: stderr || `${cmd} timed out` });
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
