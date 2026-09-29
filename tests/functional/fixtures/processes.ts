import { spawnSync } from 'node:child_process';

/**
 * Last-resort cleanup for functional tests that start real processes (PTY
 * host, echo-ai sessions, `work attach` clients). The polite path
 * (`pty-host --stop`, `registry.kill`) is tried first; this sweeps whatever
 * it left behind when a test failed half-way, so a red run doesn't leave
 * node processes holding temp dirs open. Same approach as e2e/fixtures.ts.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTree(pid: number): void {
  if (!pid || !isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Runs every step even when an earlier one throws; rethrows the first error. */
export async function runAll(steps: Array<() => void | Promise<void>>): Promise<void> {
  let first: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      first ??= e;
    }
  }
  if (first !== undefined) throw first;
}
