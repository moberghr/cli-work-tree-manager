import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startPtyHost } from '../core/pty/pty-host.js';
import { ensureHost, findHost, PtyHostBusyError, PtyHostClient, PtyHostVersionError } from '../core/pty/pty-host-client.js';
import { ensureFile, withFileLock } from '../core/platform/fs-safe.js';
import { hostStartLockPath } from '../core/pty/pty-host-protocol.js';
import { stopHost } from '../core/pty/host-control.js';
import { killTree } from '../core/platform/process.js';
import { loadHistory } from '../core/sessions/history.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { resolveWorkBinPath } from '../core/platform/work-bin.js';
import { ensureAgentPath } from '../core/agents/agent-path.js';

function info(message: string): void {
  process.stderr.write(message + '\n');
}

// Moved to core (host-control.ts): the dashboard's Restart uses it too. Re-exported for the tests.
export { stopHost, type StopOutcome } from '../core/pty/host-control.js';

async function printStatus(): Promise<void> {
  let host;
  try {
    host = await findHost();
  } catch (err) {
    if (err instanceof PtyHostVersionError || err instanceof PtyHostBusyError) {
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
      .option('status', { type: 'boolean', default: false, describe: 'List the sessions the PTY host owns.' })
      .option('force', {
        type: 'boolean',
        default: false,
        describe: "With --stop/--restart: also stop a host that doesn't answer (hung), once it proves to be work's PTY host.",
      }),
  handler: async (argv) => {
    if (argv.status) {
      await printStatus();
      return;
    }
    if (argv.stop || argv.restart) {
      const outcome = await stopHost(killTree, 5000, { force: argv.force as boolean });
      info(
        chalk.gray(
          {
            stopped: 'Stopped the PTY host.',
            'not-running': 'No PTY host running.',
            'stale-file': 'No PTY host running (removed a stale discovery file; nothing was killed).',
            unresponsive: argv.force
              ? "The PTY host is not responding, and its process doesn't look like work's PTY host: nothing was stopped."
              : 'The PTY host is not responding (busy, or hung). Nothing was stopped — try again in a moment, or add --force to stop a hung one.',
            failed: 'Could not stop the PTY host.',
          }[outcome],
        ),
      );
      if (outcome === 'failed' || outcome === 'unresponsive') {
        process.exitCode = 1;
        return; // never --restart on top of a host we couldn't stop
      }
      if (argv.stop) return;
      await new Promise((r) => setTimeout(r, 500));
      const host = await ensureHost(resolveWorkBinPath(process.argv[1]));
      info(chalk.gray(`PTY host restarted (PID ${host.pid}); sessions are being restored.`));
      return;
    }

    // Singleton: a second host would restore every saved session a second
    // time (two Claudes per conversation). Check-and-start under a lock; a
    // version-mismatched or busy (not answering in time) host still counts
    // as running.
    const lock = hostStartLockPath();
    ensureFile(lock, '');
    const handle = await withFileLock(lock, async () => {
      const running = await findHost().catch((err) =>
        err instanceof PtyHostVersionError || err instanceof PtyHostBusyError ? true : null,
      );
      if (running) return null;
      // Started by the Mac app from the Dock, the PATH is the system's: `claude` wouldn't be found and
      // every session would end at once ("exited with code 1"). The login shell's, before the restore
      // below starts any (shell-path.ts); only once we know we're the host.
      ensureAgentPath();
      // Restore INSIDE the lock, as part of starting: startPtyHost writes
      // the discovery file and reads the saved list in the same tick,
      // before any request is served — so a client spawning a session
      // can't overwrite the list first (which lost every other saved
      // session), and a racing `work remove` waits for the restore.
      return startPtyHost();
    });
    if (!handle) {
      info(chalk.gray('PTY host already running.'));
      return;
    }
    info(chalk.gray(`PTY host listening on 127.0.0.1:${handle.info.port} (PID ${process.pid})`));
    const shutdown = () => {
      void handle.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {});
  },
};
