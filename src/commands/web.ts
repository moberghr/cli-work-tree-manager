import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startWebServer } from '../core/web-server.js';
import {
  installCommandHook,
  removeCommandHookSync,
} from '../core/command-hook-installer.js';
import { openUrl } from '../utils/platform.js';
import { configurePtyPool, resumePersistedSessions } from '../core/pty-pool.js';
import { resolveWorkBinPath } from '../utils/work-bin.js';
import { setAutostart } from '../core/autostart.js';
import { startDemoServer } from '../core/demo/demo-server.js';
import { resolveWebRoot } from '../core/web-static.js';
import { isPidAlive } from '../core/process.js';
import {
  clearWebDiscovery,
  probeWeb,
  readWebPid,
  readWebUrl,
  existingWebDecision,
  writeWebDiscovery,
} from '../core/web-discovery.js';
import { bestEffort, swallow } from '../core/best-effort.js';

function info(message: string): void {
  process.stderr.write(message + '\n');
}

export type WebStopOutcome = 'stopped' | 'not-running' | 'stale' | 'unresponsive' | 'failed';

/**
 * Stop the running work web — only after it proves it's work web with the
 * recorded pid (it answers /api/context with its own pid). A stale
 * web.pid can name a process that reused the PID after a crash/reboot;
 * killing that blind could take down anything.
 */
export async function stopExisting(
  kill: (pid: number) => void = (pid) => process.kill(pid),
): Promise<WebStopOutcome> {
  const pid = readWebPid();
  const url = readWebUrl();
  if (!pid) {
    clearWebDiscovery();
    return 'not-running';
  }
  if (!isPidAlive(pid) || !url) {
    clearWebDiscovery();
    return 'stale';
  }
  const probe = await probeWeb(url, 3000);
  if (probe.kind === 'timeout') return 'unresponsive';
  if (probe.kind === 'gone' || (probe.pid !== null && probe.pid !== pid)) {
    clearWebDiscovery();
    return 'stale';
  }
  try {
    kill(pid);
  } catch {
    return 'failed';
  }
  clearWebDiscovery();
  return 'stopped';
}

export const webCommand: CommandModule = {
  command: 'web',
  describe:
    'Open the browser dashboard: every worktree session in one tab. Singleton — one process per user.',
  builder: (yargs) =>
    yargs
      .option('open', {
        type: 'boolean',
        default: true,
        describe: 'Auto-open the dashboard in the default browser. Use --no-open to skip.',
      })
      .option('stop', {
        type: 'boolean',
        default: false,
        describe: 'Stop a running work web instance and exit.',
      })
      .option('demo', {
        type: 'boolean',
        default: false,
        describe:
          'Run the dashboard against a simulated, in-memory world (no repos, agents or ~/.work touched) — for screenshots, UI work and demos. Runs beside a real work web.',
      })
      .option('autostart', {
        type: 'string',
        choices: ['on', 'off'],
        describe:
          'Start work web at login (Windows), so sessions come back after a reboot.',
      })
      .option('lean', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe:
          'Internal: start without dashboard-only features (Claude activity watcher + hooks). Used by `wd` when it auto-starts work web for a diff-only session.',
      }),
  handler: async (argv) => {
    if (argv.stop) {
      const outcome = await stopExisting();
      info(
        chalk.gray(
          {
            stopped: 'Stopped work web.',
            'not-running': 'No work web running.',
            stale: 'No work web running (removed stale discovery files; nothing was killed).',
            unresponsive: 'work web is not responding (busy?). Nothing was stopped — try again in a moment.',
            failed: 'Could not stop work web.',
          }[outcome],
        ),
      );
      process.exit(outcome === 'failed' || outcome === 'unresponsive' ? 1 : 0);
    }
    if (argv.demo) {
      await runDemo(argv.open as boolean);
      return;
    }
    if (argv.autostart) {
      try {
        const on = argv.autostart === 'on';
        const file = setAutostart(on, resolveWorkBinPath(process.argv[1]));
        info(chalk.gray(on ? `work web will start at login (${file}).` : 'Login autostart removed.'));
        process.exit(0);
      } catch (err) {
        info(chalk.red((err as Error).message));
        process.exit(1);
      }
    }

    // Singleton enforcement. Two work web servers running at once is
    // strictly bad: they fight over `~/.work/settings.json` hooks,
    // each one holds a port, and only the most-recently-started is
    // discoverable via `web.url`. Detect a live previous instance and
    // either reuse it (open browser) or refuse to start.
    const existingPid = readWebPid();
    if (existingPid && isPidAlive(existingPid)) {
      const url = readWebUrl();
      if (url && (await existingWebDecision(url)) === 'reuse') {
        info(
          chalk.gray(
            `work web already running at ${url} (PID ${existingPid}). Opening browser.`,
          ),
        );
        if (argv.open) openUrl(url);
        process.exit(0);
      }
      info(
        chalk.yellow(
          `PID ${existingPid} is alive but not responding at ${url ?? '<unknown>'}. Use \`work web --stop\` to kill it, then re-run.`,
        ),
      );
      process.exit(1);
    }
    // Stale files from a crashed previous run — wipe before we write
    // our own.
    clearWebDiscovery();

    // The PTY host is spawned from the `work` binary, not the `wd` shim.
    configurePtyPool({ workBin: resolveWorkBinPath(process.argv[1]) });
    const lean = !!argv.lean || process.env.WORK_WEB_LEAN === '1';
    const handle = await startWebServer({ lean });
    bestEffort('write work web discovery files', () => writeWebDiscovery(handle.url, process.pid));

    info(
      chalk.gray(
        `work web running at ${handle.url}${lean ? ' (lean — diff-only mode)' : ''}`,
      ),
    );
    info(chalk.gray('Press Ctrl+C to stop. Or: `work web --stop` from another shell.'));
    if (argv.open) openUrl(handle.url);

    // Reboot / crash recovery: bring back the Claude sessions that were live
    // last time. Dashboard mode only — a lean `wd` server shouldn't spin up
    // ten Claudes as a side effect of opening a diff.
    if (!lean) {
      resumePersistedSessions().then(
        (n) => { if (n > 0) info(chalk.gray(`Restoring ${n} session(s) from last time (--continue).`)); },
        (err: Error) => info(chalk.yellow(`Could not restore sessions: ${err.message}`)),
      );
    }

    // Install Claude hooks so any live Claude in a worktree we know
    // about picks up pending review comments without the user having
    // to type. Both are no-ops when nothing's pending. Removed cleanly
    // on shutdown. Skipped in lean mode — a diff-only session doesn't
    // need to mutate the user's ~/.claude/settings.json.
    if (!lean) {
      await Promise.all([
        installCommandHook({
          owner: 'web',
          event: 'UserPromptSubmit',
          command: 'work hook prompt-submit',
          timeoutSec: 5,
        }),
        installCommandHook({
          owner: 'web',
          event: 'Stop',
          command: 'work hook stop',
          timeoutSec: 5,
        }),
        // Attention inbox: every Claude reports working / done / needs
        // input, whichever terminal it runs in. Separate owner so the set
        // is managed independently of comment delivery.
        ...(
          [
            ['UserPromptSubmit', 'work hook status-prompt'],
            ['Stop', 'work hook status-stop'],
            ['Notification', 'work hook status-notify'],
          ] as const
        ).map(([event, command]) =>
          installCommandHook({ owner: 'web-status', event, command, timeoutSec: 5 }),
        ),
      ]).catch(swallow('install Claude hooks (comments/status) in ~/.claude/settings.json'));
    }

    // Checkpoint-on-turn-end hook. Installed in BOTH lean and full mode —
    // unlike comment delivery, meaningful per-turn checkpoints are the whole
    // point of the `wd` diff view. Distinct owner so it's managed separately
    // from the comment hooks. Fires `work hook checkpoint`, which nudges this
    // server to snapshot the cwd's scope (a no-op when none matches).
    await installCommandHook({
      owner: 'web-checkpoint',
      event: 'Stop',
      command: 'work hook checkpoint',
      timeoutSec: 5,
    }).catch(swallow('install Claude checkpoint hook in ~/.claude/settings.json'));

    // Seal-on-prompt hook — the instruction boundary. A new user prompt
    // closes the current step so the work answering it opens a fresh one
    // (one step per instruction, not per turn). Installed in BOTH modes, same
    // owner as the Stop checkpoint hook above.
    await installCommandHook({
      owner: 'web-checkpoint',
      event: 'UserPromptSubmit',
      command: 'work hook checkpoint-seal',
      timeoutSec: 5,
    }).catch(swallow('install Claude checkpoint hook in ~/.claude/settings.json'));

    const shutdown = () => {
      info(chalk.gray('\nStopping work web.'));
      clearWebDiscovery();
      if (!lean) {
        bestEffort(`remove Claude hook web/UserPromptSubmit`, () => removeCommandHookSync('web', 'UserPromptSubmit'));
        bestEffort(`remove Claude hook web/Stop`, () => removeCommandHookSync('web', 'Stop'));
        for (const ev of ['UserPromptSubmit', 'Stop', 'Notification']) {
          bestEffort(`remove Claude hook web-status/${ev}`, () => removeCommandHookSync('web-status', ev));
        }
      }
      bestEffort(`remove Claude hook web-checkpoint/Stop`, () => removeCommandHookSync('web-checkpoint', 'Stop'));
      bestEffort(`remove Claude hook web-checkpoint/UserPromptSubmit`, () => removeCommandHookSync('web-checkpoint', 'UserPromptSubmit'));
      handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // Windows doesn't deliver SIGTERM reliably; trap exit too so we
    // best-effort clean up our pid/url files even on abrupt deaths.
    process.on('exit', () => {
      clearWebDiscovery();
    });
    await new Promise(() => {});
  },
};

/**
 * `work web --demo`: the real SPA against the in-memory demo API. It is not
 * the singleton — no web.url / web.pid, no Claude hooks, no PTY host — so it
 * can run next to a real work web without either noticing the other.
 */
async function runDemo(open: boolean): Promise<void> {
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    info(chalk.red('Could not find dist/web/. Run `npm run build` first.'));
    process.exit(1);
  }
  const handle = await startDemoServer({ webRoot });
  info(chalk.cyan(`work web DEMO at ${handle.url}`));
  info(chalk.gray('Simulated data only: nothing here touches your repos, agents or ~/.work. Ctrl+C to stop.'));
  if (open) openUrl(handle.url);
  const stop = () => {
    void handle.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}
