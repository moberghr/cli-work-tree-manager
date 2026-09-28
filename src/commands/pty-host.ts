import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startPtyHost } from '../core/pty-host.js';
import { ensureHost, findHost, probeHost, PtyHostClient, PtyHostVersionError } from '../core/pty-host-client.js';
import { getConfigDir } from '../core/config.js';
import { ensureFile, withFileLock } from '../core/fs-safe.js';
import { hostInfoPath, readHostInfo } from '../core/pty-host-protocol.js';
import { loadHistory } from '../core/history.js';
import { sessionIdFor } from '../core/web-state.js';
import { resolveWorkBinPath } from './diff.js';

function info(message: string): void {
  process.stderr.write(message + '\n');
}

export type StopOutcome = 'stopped' | 'not-running' | 'stale-file' | 'failed';

/**
 * Kill the running host and its PTYs. The persisted session list stays, so
 * the next host start restores them with --continue.
 *
 * Only a PID that proves it's our host gets killed: it must answer /health
 * with the discovery file's token and report that same PID. The file
 * survives crashes and reboots (TerminateProcess skips cleanup), and
 * Windows reuses PIDs — force-killing the recorded PID and its tree blind
 * could take down an unrelated process. A stale file is just removed.
 */
export async function stopHost(
  kill: (pid: number) => boolean = killTree,
): Promise<StopOutcome> {
  const hostInfo = readHostInfo();
  if (!hostInfo) return 'not-running';
  const probe = await probeHost(hostInfo);
  if (!probe || probe.pid !== hostInfo.pid) {
    try { fs.unlinkSync(hostInfoPath()); } catch { /* */ }
    return 'stale-file';
  }
  const ok = kill(hostInfo.pid);
  // TerminateProcess means the host never runs its own cleanup.
  try { fs.unlinkSync(hostInfoPath()); } catch { /* */ }
  return ok ? 'stopped' : 'failed';
}

function killTree(pid: number): boolean {
  if (process.platform === 'win32') {
    // TerminateProcess on the host alone can orphan its ConPTY children —
    // Claudes that keep running unseen, and that a restore would then
    // duplicate on the same conversation. Kill the whole tree.
    return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).status === 0;
  }
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/** Held by a starting host from "is one running?" until its discovery file
 *  is written, so two `work pty-host` processes can't both start. */
function hostStartLockPath(): string {
  return path.join(getConfigDir(), 'pty-host.start.lock');
}

async function printStatus(): Promise<void> {
  let host;
  try {
    host = await findHost();
  } catch (err) {
    if (err instanceof PtyHostVersionError) {
      info(chalk.yellow(err.message));
      return;
    }
    throw err;
  }
  if (!host) {
    info(chalk.gray('No PTY host running.'));
    return;
  }
  const ptys = await new PtyHostClient(host).list();
  const names = new Map(loadHistory().map((s) => [sessionIdFor(s), `${s.target} · ${s.branch}`]));
  info(chalk.gray(`PTY host PID ${host.pid}, port ${host.port} — ${ptys.length} session(s)`));
  for (const p of ptys) {
    const state = p.exited ? chalk.red('exited') : chalk.green('live');
    const tag = p.restored ? chalk.gray(' (restored)') : '';
    info(`  ${state}  ${names.get(p.id) ?? p.id}${tag}  ${chalk.gray(p.cwd)}`);
  }
}

export const ptyHostCommand: CommandModule = {
  command: 'pty-host',
  describe: false, // internal — started on demand by `work web` / `work attach`
  builder: (yargs) =>
    yargs
      .option('stop', { type: 'boolean', default: false, describe: 'Stop the PTY host (sessions restore on next start).' })
      .option('restart', { type: 'boolean', default: false, describe: 'Restart the PTY host, e.g. after upgrading work.' })
      .option('status', { type: 'boolean', default: false, describe: 'List the sessions the PTY host owns.' }),
  handler: async (argv) => {
    if (argv.status) {
      await printStatus();
      return;
    }
    if (argv.stop || argv.restart) {
      const outcome = await stopHost();
      info(
        chalk.gray(
          {
            stopped: 'Stopped the PTY host.',
            'not-running': 'No PTY host running.',
            'stale-file': 'No PTY host running (removed a stale discovery file; nothing was killed).',
            failed: 'Could not stop the PTY host.',
          }[outcome],
        ),
      );
      if (outcome === 'failed') process.exitCode = 1;
      if (argv.stop) return;
      await new Promise((r) => setTimeout(r, 500));
      const host = await ensureHost(resolveWorkBinPath(process.argv[1]));
      info(chalk.gray(`PTY host restarted (PID ${host.pid}); sessions are being restored.`));
      return;
    }

    // Singleton: a second host would restore every saved session a second
    // time (two Claudes per conversation). Check-and-start under a lock; a
    // version-mismatched host still counts as running.
    const lock = hostStartLockPath();
    ensureFile(lock, '');
    const handle = await withFileLock(lock, async () => {
      const running = await findHost().catch((err) =>
        err instanceof PtyHostVersionError ? true : null,
      );
      if (running) return null;
      // Restore AFTER the lock is released (below): it can take a while and
      // the discovery file is already written, so no one else will start.
      return startPtyHost({ restore: false });
    });
    if (!handle) {
      info(chalk.gray('PTY host already running.'));
      return;
    }
    await handle.registry.restore();
    info(chalk.gray(`PTY host listening on 127.0.0.1:${handle.info.port} (PID ${process.pid})`));
    const shutdown = () => {
      void handle.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {});
  },
};
