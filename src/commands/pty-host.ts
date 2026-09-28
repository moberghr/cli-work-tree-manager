import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startPtyHost } from '../core/pty-host.js';
import { ensureHost, findHost, PtyHostClient, PtyHostVersionError } from '../core/pty-host-client.js';
import { hostInfoPath, readHostInfo } from '../core/pty-host-protocol.js';
import { loadHistory } from '../core/history.js';
import { sessionIdFor } from '../core/web-state.js';
import { resolveWorkBinPath } from './diff.js';

function info(message: string): void {
  process.stderr.write(message + '\n');
}

/** Kill the running host and its PTYs. The persisted session list stays,
 *  so the next host start restores them with --continue. */
function stopHost(): boolean {
  const hostInfo = readHostInfo();
  if (!hostInfo) return false;
  let stopped = false;
  if (process.platform === 'win32') {
    // TerminateProcess on the host alone can orphan its ConPTY children —
    // Claudes that keep running unseen, and that a restore would then
    // duplicate on the same conversation. Kill the whole tree.
    const r = spawnSync('taskkill', ['/PID', String(hostInfo.pid), '/T', '/F'], { stdio: 'ignore' });
    stopped = r.status === 0;
  } else {
    try {
      process.kill(hostInfo.pid);
      stopped = true;
    } catch { /* already gone */ }
  }
  // On Windows process.kill is TerminateProcess — the host never runs its
  // own cleanup — so remove the discovery file here. Harmless either way
  // (clients health-check it) but it shouldn't linger.
  try { fs.unlinkSync(hostInfoPath()); } catch { /* */ }
  return stopped;
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
      const stopped = stopHost();
      info(chalk.gray(stopped ? 'Stopped the PTY host.' : 'No PTY host running.'));
      if (argv.stop) return;
      await new Promise((r) => setTimeout(r, 500));
      const host = await ensureHost(resolveWorkBinPath(process.argv[1]));
      info(chalk.gray(`PTY host restarted (PID ${host.pid}); sessions are being restored.`));
      return;
    }

    // Singleton: a second host would fight over pty-sessions.json and the
    // discovery file. A version-mismatched one still counts as running.
    const running = await findHost().catch((err) =>
      err instanceof PtyHostVersionError ? true : null,
    );
    if (running) {
      info(chalk.gray('PTY host already running.'));
      return;
    }

    const handle = await startPtyHost();
    info(chalk.gray(`PTY host listening on 127.0.0.1:${handle.info.port} (PID ${process.pid})`));
    const shutdown = () => {
      void handle.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {});
  },
};
