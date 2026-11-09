import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { programPath } from '../platform/program-path.js';
import { ensureHost, probeHostDetailed } from './pty-host-client.js';
import { hostInfoPath, readHostInfo } from './pty-host-protocol.js';
import { isPidAlive, killTree } from '../platform/process.js';

/**
 * Stopping and restarting the PTY host — the CLI's `work pty-host
 * --stop/--restart` and the dashboard's Restart share it. The persisted
 * session list stays, so the next host restores them with --continue.
 */

export type StopOutcome = 'stopped' | 'not-running' | 'stale-file' | 'unresponsive' | 'failed';

/** A process's command line, or null when it isn't running or can't be read (Windows: CIM; elsewhere: ps). */
export function commandLineOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (err: Error | null, out: string) => resolve(err ? null : out.trim() || null);
    if (process.platform === 'win32')
      execFile(
        programPath('powershell'),
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CommandLine`],
        { windowsHide: true, timeout: 15_000 },
        (err, out) => done(err, String(out)),
      );
    else
      execFile(programPath('ps'), ['-o', 'args=', '-p', String(Math.trunc(pid))], { windowsHide: true, timeout: 5000 }, (err, out) =>
        done(err, String(out)),
      );
  });
}

/**
 * The recorded pid really is a running PTY host of work's: alive, and its command line runs `pty-host` (not a
 * `--stop`/`--restart`/`--status` call). Pids get reused — on Windows fast — so a host that doesn't answer is only
 * force-stopped after this: blind, it could take down any process that took its number. Pure over its inputs.
 */
export function looksLikeHost(commandLine: string | null): boolean {
  return (
    !!commandLine && /(^|\s|["'\\/])pty-host(\s|$|["'])/.test(commandLine) && !/\bpty-host\b.*--(stop|restart|status)\b/.test(commandLine)
  );
}

/**
 * Kill the running host and its PTYs. Only a PID that proves it's our host gets killed: it answers /health with the
 * discovery file's token and that same PID — or, with `force`, it doesn't answer at all (hung: a ConPTY start that
 * blocked its event loop) but its process is alive and runs `work pty-host` (`looksLikeHost`). The file survives
 * crashes and reboots (TerminateProcess skips cleanup), and Windows reuses PIDs. A stale file is just removed.
 */
export async function stopHost(
  kill: (pid: number) => boolean = killTree,
  probeTimeoutMs = 5000,
  opts: { force?: boolean; isOurHost?: (pid: number) => Promise<boolean> } = {},
): Promise<StopOutcome> {
  const hostInfo = readHostInfo();
  if (!hostInfo) return 'not-running';
  // A busy host (restoring many sessions) can miss a short probe; give it
  // longer before concluding anything.
  const probe = await probeHostDetailed(hostInfo, probeTimeoutMs);
  if (probe.kind === 'timeout') {
    // Alive-but-slow must NOT be treated as stale: deleting the file would
    // orphan a live host, and --restart would then start a second one that
    // restores every session again. Keep the file, kill nothing — unless
    // asked to stop a hung one, and it proves to be ours.
    const ours = opts.isOurHost ?? (async (pid: number) => isPidAlive(pid) && looksLikeHost(await commandLineOf(pid)));
    if (!opts.force || !(await ours(hostInfo.pid))) return 'unresponsive';
    return killAndForget(kill, hostInfo.pid);
  }
  if (probe.kind !== 'host' || probe.pid !== hostInfo.pid) {
    // Nothing listening, or someone else on that port: the file is stale
    // (reboot, crash, PID/port reused). Remove it; kill nothing.
    removeInfo();
    return 'stale-file';
  }
  return killAndForget(kill, hostInfo.pid);
}

function killAndForget(kill: (pid: number) => boolean, pid: number): StopOutcome {
  const ok = kill(pid);
  // TerminateProcess means the host never runs its own cleanup.
  removeInfo();
  return ok ? 'stopped' : 'failed';
}

function removeInfo(): void {
  try {
    fs.unlinkSync(hostInfoPath());
  } catch {
    /* */
  }
}

/**
 * Stop the host and start a new one, which restores every saved session with --continue. `force`: a host that
 * doesn't answer is stopped too (see stopHost). Never starts a second host beside one it couldn't stop.
 */
export async function restartHost(
  workBin: string,
  opts: { force?: boolean } = {},
  steps: { stop?: (force: boolean) => Promise<StopOutcome>; start?: (workBin: string) => Promise<{ pid: number }>; pauseMs?: number } = {},
): Promise<{ outcome: StopOutcome; pid: number | null }> {
  const outcome = await (steps.stop ?? ((force) => stopHost(killTree, 5000, { force })))(!!opts.force);
  if (outcome === 'failed' || outcome === 'unresponsive') return { outcome, pid: null };
  // The old one's port and lock let go before the new one takes them.
  await new Promise((r) => setTimeout(r, steps.pauseMs ?? 500));
  const host = await (steps.start ?? ensureHost)(workBin);
  return { outcome, pid: host.pid };
}
