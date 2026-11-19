import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startWebServer } from '../server/web-server.js';
import { knownAgents } from '../core/agents/index.js';
import { settleAgentHooks, type HookMigrationIo, type HookMigrationStep } from '../core/agents/hook-migration.js';
import { findSessionForCwd } from '../core/comments/pending-delivery.js';
import { listProcesses } from '../core/platform/running-from.js';
import { debugLog } from '../core/platform/logger.js';
import { setupAgentUsage } from '../core/usage/usage-setup.js';
import { loadConfig } from '../core/platform/config.js';
import { openUrl } from '../core/platform/launch.js';
import { configurePtyPool, ptyPids, resumePersistedSessions } from '../core/pty/pty-pool.js';
import { resolveWorkBinPath } from '../core/platform/work-bin.js';
import { setAutostart } from '../core/platform/autostart.js';
import { startDemoServer } from '../server/demo/demo-server.js';
import { resolveWebRoot } from '../core/platform/web-static.js';
import { isPidAlive } from '../core/platform/process.js';
import {
  clearDevWebDiscovery,
  clearWebDiscovery,
  discoveryCheck,
  findDevWeb,
  probeWeb,
  readWebPid,
  readWebUrl,
  existingWebDecision,
  writeDevWebDiscovery,
  writeWebDiscovery,
} from '../core/platform/web-discovery.js';
import { pendingMigration } from '../core/platform/db.js';
import { bestEffort, logSwallowed, swallow } from '../core/platform/best-effort.js';

/** How often a work web looks again while agents from before the update still run on the old hooks. */
const HOOK_MIGRATION_EVERY_MS = 2 * 60_000;

/**
 * Take out what older work webs wrote into each agent's own settings (Claude: ~/.claude/settings.json and every
 * account's): their hooks, and the status line they wrapped. The agents work starts carry both themselves now
 * (agents/session-hooks.ts, `AgentLaunch.sessionTool`); left in the user's settings, every agent run on the machine fired
 * them, with whatever `work` its PATH found. Settings already clean aren't written. Lean too: wd's server once
 * installed its checkpoint hooks the same way.
 *
 * Without a session missing a turn (agents/hook-migration.ts): while a session's agent started before this work web
 * still runs, the hooks stay — as the exact commands its new agents carry — and go once none is left. Looked at again
 * every two minutes until then. Resolves when the first step is done; returns a stop for the timer.
 */
export async function removeRetiredAgentSetup(
  io: Partial<HookMigrationIo> & { everyMs?: number } = {},
): Promise<{ stop: () => void; first: HookMigrationStep[] }> {
  const since = io.since ?? Date.now();
  const migrationIo: HookMigrationIo = {
    since,
    commandLines: io.commandLines ?? (async () => new Map((await listProcesses()).map((p) => [p.pid, p.command]))),
    inSession: io.inSession ?? ((cwd) => findSessionForCwd(cwd) !== null),
    hostPids: io.hostPids ?? ptyPids,
    ...(io.agents ? { agents: io.agents } : {}),
  };
  const step = async (): Promise<HookMigrationStep[]> => {
    try {
      const done = await settleAgentHooks(migrationIo);
      for (const d of done)
        if (d.done === 'bridged')
          debugLog('INFO', `[hooks] ${d.agent}: kept in its settings for ${d.waitingOn} session(s) started before the update`);
      return done;
    } catch (err) {
      logSwallowed("move the agents' hooks out of their settings", err);
      return [];
    }
  };
  // The status line older builds wrapped goes back at once: a running agent then shows the user's own (its readings
  // come from the agents started since), never a broken line.
  await setupAgentUsage(knownAgents(), loadConfig(), false).catch(swallow("give back the agents' status lines"));
  const first = await step();
  let last = first;
  const timer = setInterval(() => {
    if (last.length > 0 && last.every((d) => d.done === 'removed')) return clearInterval(timer);
    void step().then((d) => (last = d));
  }, io.everyMs ?? HOOK_MIGRATION_EVERY_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), first };
}

function info(message: string): void {
  process.stderr.write(message + '\n');
}

import { buildStamp } from '../core/platform/build-stamp.js';
import { previousEnd, readWebLife, recordExit, startWebLife, stopOnSignals } from '../core/platform/web-life.js';
import { VERSION } from '../version.js';
import { ensureAgentPath } from '../core/agents/agent-path.js';

export type WebStopOutcome = 'stopped' | 'not-running' | 'stale' | 'unresponsive' | 'failed';

/**
 * Stop the running work web — only after it proves it's work web with the
 * recorded pid (it answers /api/context with its own pid). A stale
 * web.pid can name a process that reused the PID after a crash/reboot;
 * killing that blind could take down anything.
 */
export async function stopExisting(kill: (pid: number) => void = (pid) => process.kill(pid), graceMs = 8000): Promise<WebStopOutcome> {
  const pid = readWebPid();
  const url = readWebUrl();
  if (!pid) {
    clearWebDiscovery();
    return 'not-running';
  }
  if (!isPidAlive(pid) || !url) {
    clearWebDiscovery(pid);
    return 'stale';
  }
  const probe = await probeWeb(url, 3000);
  if (probe.kind === 'timeout') return 'unresponsive';
  if (probe.kind === 'gone' || (probe.pid !== null && probe.pid !== pid)) {
    clearWebDiscovery(pid);
    return 'stale';
  }
  // Ask it to run its own shutdown first (removes its Claude hooks, sweeps
  // checkpoint refs); a hard kill skips all that on Windows. Kill only if
  // it doesn't go.
  const asked = await fetch(`${url}api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (asked) {
    const until = Date.now() + graceMs;
    while (Date.now() < until && isPidAlive(pid)) await new Promise((r) => setTimeout(r, 100));
  }
  if (isPidAlive(pid)) {
    try {
      kill(pid);
    } catch {
      return 'failed';
    }
  }
  clearWebDiscovery(pid);
  return 'stopped';
}

export const webCommand: CommandModule = {
  command: 'web',
  describe: 'Open the browser dashboard: every worktree session in one tab. Singleton — one process per user.',
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
      .option('dev', {
        type: 'boolean',
        default: false,
        describe:
          "A second server with this checkout's build, next to the real work web, on the same sessions — what the dev app shows. No Claude hooks, notifications or background jobs (the real one keeps those); refuses a build that would migrate state.db. With --stop: stop it.",
      })
      .option('autostart', {
        type: 'string',
        choices: ['on', 'off'],
        describe: 'Start work web at login (Windows), so sessions come back after a reboot.',
      })
      .option('lean', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe:
          'Internal: start without dashboard-only features (Claude activity watcher + hooks). Used by `wd` when it auto-starts work web for a diff-only session.',
      }),
  handler: async (argv) => {
    if (argv.dev) {
      if (argv.stop) process.exit((await stopDev()) ? 0 : 1);
      await runDev(argv.open as boolean);
      return;
    }
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
    // strictly bad: each one holds a port, and only the most-recently-started is
    // discoverable via `web.url`. Detect a live previous instance and
    // either reuse it (open browser) or refuse to start.
    const lean = !!argv.lean || process.env.WORK_WEB_LEAN === '1';
    const existingPid = readWebPid();
    if (existingPid && isPidAlive(existingPid) && !lean) {
      // A lean instance (autostarted by `wd`) has no Claude hooks, inbox,
      // PR watch or session restore — reusing it for `work web` left all of
      // that silently off. Replace it with the full server. Likewise one
      // from an older build: it outlived a rebuild or upgrade, and reads
      // state and serves routes as they were then (build-stamp.ts).
      const url = readWebUrl();
      const probe = url ? await probeWeb(url, 3000) : null;
      if (probe?.kind === 'ours' && (probe.lean || probe.build !== buildStamp())) {
        info(
          chalk.gray(
            probe.lean
              ? 'Replacing the lean work web that `wd` started with the full dashboard…'
              : 'Replacing the running work web: it is from an older build than this one.',
          ),
        );
        await stopExisting();
      }
    }
    if (existingPid && isPidAlive(existingPid)) {
      const url = readWebUrl();
      if (url && (await existingWebDecision(url)) === 'reuse') {
        info(chalk.gray(`work web already running at ${url} (PID ${existingPid}). Opening browser.`));
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

    // Started by the Mac app from the Dock, the PATH is the system's: `claude` wouldn't be found and
    // every session would end at once ("exited with code 1"). Take the login shell's before the PTY
    // host — which inherits it — is started (shell-path.ts). Not wd's lean server: it starts no agent,
    // and wd waits only a few seconds for it.
    if (!lean) ensureAgentPath();

    // The PTY host is spawned from the `work` binary, not the `wd` shim.
    configurePtyPool({ workBin: resolveWorkBinPath(process.argv[1]) });
    let shutdown = (_how: string) => {};
    // How the last one ended, when it couldn't say (killed outright: nothing in the log), and this one's record.
    const before = previousEnd(readWebLife(), isPidAlive, process.pid);
    if (before) info(chalk.yellow(`Note: ${before}`));
    const life = startWebLife(VERSION);
    recordExit(process, life);
    const handle = await startWebServer({
      lean,
      onShutdownRequest: () => shutdown('asked to stop (work web --stop, or the app replacing it)'),
    });
    bestEffort('write work web discovery files', () => writeWebDiscovery(handle.url, process.pid));

    info(chalk.gray(`work web running at ${handle.url}${lean ? ' (lean — diff-only mode)' : ''}`));
    info(chalk.gray('Press Ctrl+C to stop. Or: `work web --stop` from another shell.'));
    if (argv.open) openUrl(handle.url);

    // Reboot / crash recovery: bring back the Claude sessions that were live
    // last time. Dashboard mode only — a lean `wd` server shouldn't spin up
    // ten Claudes as a side effect of opening a diff.
    if (!lean) {
      resumePersistedSessions().then(
        (n) => {
          if (n > 0) info(chalk.gray(`Restoring ${n} session(s) from last time (--continue).`));
        },
        (err: Error) => info(chalk.yellow(`Could not restore sessions: ${err.message}`)),
      );
    }

    // The hooks and status line live with the Claudes work starts (`--settings`, agents/session-hooks.ts): nothing is
    // installed in the user's settings any more, and what older builds put there goes.
    const hookMigration = await removeRetiredAgentSetup();

    shutdown = (how: string) => {
      life.end(how);
      hookMigration.stop();
      info(chalk.gray(`\nStopping work web (${how}).`));
      clearWebDiscovery(process.pid);
      void handle.stop().finally(() => process.exit(0));
    };
    stopOnSignals(process, (how) => shutdown(how));
    // Still the one? Two can start at once (a restart racing the desktop
    // app's watchdog); the one not in web.pid steps aside, leaving the
    // discovery files, which are the other's. Nothing recorded: put ours back.
    const discoveryTimer = setInterval(() => {
      life.beat(); // still alive: the next one can tell when this one was last seen
      void discoveryCheck({ pid: process.pid, url: handle.url }).then((d) => {
        if (d === 'reclaim') bestEffort('rewrite work web discovery files', () => writeWebDiscovery(handle.url, process.pid));
        if (d !== 'retire') return;
        info(chalk.gray(`Another work web (${readWebUrl()}) is the running one; stopping this duplicate.`));
        life.end(`stopped as a duplicate: ${readWebUrl()} is the running one`);
        clearInterval(discoveryTimer);
        void handle.stop().finally(() => process.exit(0));
      }, swallow('check work web discovery'));
    }, 20_000);
    discoveryTimer.unref?.();
    // Windows doesn't deliver SIGTERM reliably; trap exit too so we
    // best-effort clean up our pid/url files even on abrupt deaths.
    process.on('exit', () => {
      // Ours only: by the time this runs a replacement may have written its own.
      clearWebDiscovery(process.pid);
    });
    await new Promise(() => {});
  },
};

/**
 * `work web --dev`: this checkout's build beside the installed work, on the
 * same state.db and PTY host — the latest code on your real sessions. Not
 * the singleton: its own discovery files (web-dev.url, which only the dev
 * app reads), no Claude hooks, and none of the jobs that act
 * (startWebServer's `dev`). One at a time: a second start reuses it.
 */
async function runDev(open: boolean): Promise<void> {
  const found = await findDevWeb();
  if (found.kind === 'running') {
    info(chalk.gray(`work web --dev already running at ${found.url} (PID ${found.pid}).`));
    if (open) openUrl(found.url);
    process.exit(0);
  }
  if (found.kind === 'busy') {
    info(chalk.yellow(`A dev server (PID ${found.pid}) runs but isn't answering. Try again in a moment, or end that process.`));
    process.exit(1);
  }
  let pending: ReturnType<typeof pendingMigration>;
  try {
    pending = pendingMigration();
  } catch (err) {
    info(chalk.red(`Couldn't read state.db: ${(err as Error).message}. Try again in a moment.`));
    process.exit(1);
  }
  if (pending?.from === 0) {
    info(chalk.red("There's no state.db yet: the installed work makes it. Start it (its app or `work web`) once, then the dev server."));
    process.exit(1);
  }
  if (pending) {
    info(
      chalk.red(
        `This build would move state.db from schema v${pending.from} to v${pending.to}, and the installed work would then read a database newer than it knows. ` +
          "Try it on the demo (npm run app:demo), or stop the installed app's work web and run `work web` from this checkout.",
      ),
    );
    process.exit(1);
  }
  configurePtyPool({ workBin: resolveWorkBinPath(process.argv[1]), startHost: false });
  let stop = () => {};
  const handle = await startWebServer({ dev: true, onShutdownRequest: () => stop() });
  bestEffort('write the dev server discovery files', () => writeDevWebDiscovery(handle.url, process.pid));
  info(chalk.cyan(`work web DEV at ${handle.url}`));
  info(
    chalk.gray(
      "This checkout's build on your real sessions, beside the installed work. Claude hooks, notifications and background jobs stay with the real work web.",
    ),
  );
  if (open) openUrl(handle.url);
  stop = () => {
    clearDevWebDiscovery(process.pid);
    void handle.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => clearDevWebDiscovery(process.pid));
  await new Promise(() => {});
}

/** `work web --dev --stop`: ask the dev server to shut down (only it: findDevWeb), and wait until it has. */
async function stopDev(): Promise<boolean> {
  const found = await findDevWeb();
  if (found.kind === 'none') {
    info(chalk.gray('No dev server running.'));
    return true;
  }
  if (found.kind === 'busy') {
    info(chalk.yellow(`The dev server (PID ${found.pid}) isn't answering. Nothing was stopped: try again in a moment.`));
    return false;
  }
  const asked = await fetch(`${found.url}api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  // Gone before the next start, or that start would find it still there and reuse the old build.
  const waitGone = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until && isPidAlive(found.pid)) await new Promise((r) => setTimeout(r, 100));
  };
  if (asked) await waitGone(10_000);
  // Still there: end it, as `work web --stop` does. It is ours — it answered as the dev server with this pid.
  if (isPidAlive(found.pid)) {
    try {
      process.kill(found.pid);
    } catch {
      /* gone meanwhile, or not ours to end */
    }
    await waitGone(3000);
  }
  const gone = !isPidAlive(found.pid);
  if (gone) clearDevWebDiscovery(found.pid);
  info(gone ? chalk.gray('Stopped the dev server.') : chalk.red(`The dev server (PID ${found.pid}) did not stop.`));
  return gone;
}

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
