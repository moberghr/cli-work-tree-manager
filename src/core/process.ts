import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Process lifecycle rules for the long-lived pieces (work web, the PTY
 * host), in one place — they differ on Windows in ways that bit us:
 *
 *   - Killing: process.kill on Windows is TerminateProcess of that one
 *     process — its ConPTY children (Claudes) survive, orphaned. Kill the
 *     tree with taskkill /T /F. Elsewhere SIGTERM lets the process clean up
 *     its own children.
 *   - Liveness: `process.kill(pid, 0)` works on both, but a live PID is not
 *     proof it's OURS (Windows reuses PIDs fast) — callers that act on it
 *     must also verify identity (e.g. the host's /health token check).
 *   - Detached `work` children: `detached` + `windowsHide` so no console
 *     window flashes and the child outlives the parent's terminal; output
 *     goes to a log file, never the parent's stdio.
 */

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process AND its children. True if the kill was delivered. */
export function killTree(pid: number): boolean {
  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;
  }
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start `node <workBin> ...args` detached, appending its output to
 * `logFile`. Returns immediately; the caller polls for readiness (a
 * discovery file / health check), because a detached child can't report
 * back directly.
 */
export function spawnDetachedWork(workBin: string, args: string[], logFile: string): void {
  const log = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [workBin, ...args], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
