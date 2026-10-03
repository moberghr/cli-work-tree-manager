import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startWebServer } from '../core/web-server.js';
import { knownAgents, type TurnEdge, type WorkHook } from '../core/agents/index.js';
import { openUrl } from '../utils/platform.js';
import { configurePtyPool, resumePersistedSessions } from '../core/pty-pool.js';
import { resolveWorkBinPath } from '../utils/work-bin.js';
import { setAutostart } from '../core/autostart.js';
import { startDemoServer } from '../core/demo/demo-server.js';
import { resolveWebRoot } from '../core/web-static.js';
import { isPidAlive } from '../core/process.js';
import {
  clearWebDiscovery,
  discoveryCheck,
  probeWeb,
  readWebPid,
  readWebUrl,
  existingWebDecision,
  writeWebDiscovery,
} from '../core/web-discovery.js';
import { bestEffort, swallow } from '../core/best-effort.js';

/**
 * The Claude hooks work web installs. Full dashboard: ONE hook per turn
 * edge — `turn-start` (seal the checkpoint step, record "working", attach
 * pending comments) and `turn-end` (checkpoint, record "done", deliver) —
 * instead of three, each a `work` (node) start for every turn of every
 * Claude on the machine; plus the permission-prompt Notification. Lean
 * (`wd`): checkpoints only.
 */
export const FULL_HOOKS: WorkHook[] = [
  { owner: 'web-turn', edge: 'turn-start', command: 'work hook turn-start', timeoutSec: 10 },
  { owner: 'web-turn', edge: 'turn-end', command: 'work hook turn-end', timeoutSec: 10 },
  { owner: 'web-status', edge: 'notify', command: 'work hook status-notify', timeoutSec: 5 },
];
export const LEAN_HOOKS: WorkHook[] = [
  { owner: 'web-checkpoint', edge: 'turn-end', command: 'work hook checkpoint', timeoutSec: 5 },
  { owner: 'web-checkpoint', edge: 'turn-start', command: 'work hook checkpoint-seal', timeoutSec: 5 },
];
/** The separate hooks of before (and lean's, which the full set replaces): removed. */
export const LEGACY_HOOKS: Array<{ owner: string; edge: TurnEdge }> = [
  { owner: 'web', edge: 'turn-start' },
  { owner: 'web', edge: 'turn-end' },
  { owner: 'web-status', edge: 'turn-start' },
  { owner: 'web-status', edge: 'turn-end' },
  { owner: 'web-checkpoint', edge: 'turn-start' },
  { owner: 'web-checkpoint', edge: 'turn-end' },
];

/** The agents whose hooks work web installs: every one it has an adapter with hooks for. */
const hookedAgents = () => knownAgents().filter((a) => a.events);

/** Install work's hooks in every such agent's settings (full: one per turn edge + notify, and the old ones go; lean: checkpoints). */
export async function installAgentHooks(lean: boolean, onError: (agent: string) => (err: unknown) => void = () => () => {}): Promise<void> {
  for (const agent of hookedAgents()) {
    await agent.events!.install(lean ? LEAN_HOOKS : FULL_HOOKS, lean ? [] : LEGACY_HOOKS).catch(onError(agent.name));
  }
}

/** Remove them again, synchronously (shutdown). */
export function removeAgentHooksSync(lean: boolean): void {
  const ours = (lean ? LEAN_HOOKS : FULL_HOOKS).map(({ owner, edge }) => ({ owner, edge }));
  for (const agent of hookedAgents()) bestEffort(`remove ${agent.name} hooks`, () => agent.events!.removeSync([...ours, ...LEGACY_HOOKS]));
}

function info(message: string): void {
  process.stderr.write(message + '\n');
}

import { buildStamp } from '../core/build-stamp.js';

export type WebStopOutcome = 'stopped' | 'not-running' | 'stale' | 'unresponsive' | 'failed';

/**
 * Stop the running work web — only after it proves it's work web with the
 * recorded pid (it answers /api/context with its own pid). A stale
 * web.pid can name a process that reused the PID after a crash/reboot;
 * killing that blind could take down anything.
 */
export async function stopExisting(
  kill: (pid: number) => void = (pid) => process.kill(pid),
  graceMs = 8000,
): Promise<WebStopOutcome> {
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
    let shutdown = () => {};
    const handle = await startWebServer({ lean, onShutdownRequest: () => shutdown() });
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

    // Claude hooks (one write of ~/.claude/settings.json, see HOOKS):
    // the full dashboard puts delivery, status and checkpoints in one hook
    // per turn edge; the lean `wd` server only needs the checkpoints.
    await installAgentHooks(lean, (name) => swallow(`install ${name} hooks`));

    shutdown = () => {
      info(chalk.gray('\nStopping work web.'));
      clearWebDiscovery(process.pid);
      removeAgentHooksSync(lean);
      void handle.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // Still the one? Two can start at once (a restart racing the desktop
    // app's watchdog); the one not in web.pid steps aside. It leaves the
    // Claude hooks alone — they are removed by owner, and the other server
    // installed the same ones — and the discovery files, which are the
    // other's. Nothing recorded: put ours back.
    const discoveryTimer = setInterval(() => {
      void discoveryCheck({ pid: process.pid, url: handle.url }).then((d) => {
        if (d === 'reclaim') bestEffort('rewrite work web discovery files', () => writeWebDiscovery(handle.url, process.pid));
        if (d !== 'retire') return;
        info(chalk.gray(`Another work web (${readWebUrl()}) is the running one; stopping this duplicate.`));
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
