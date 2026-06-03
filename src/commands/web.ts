import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { startWebServer } from '../core/web-server.js';
import {
  installCommandHook,
  removeCommandHookSync,
} from '../core/command-hook-installer.js';
import { openUrl } from '../utils/platform.js';

function info(message: string): void {
  process.stderr.write(message + '\n');
}

function urlFilePath(): string {
  return path.join(os.homedir(), '.work', 'web.url');
}
function pidFilePath(): string {
  return path.join(os.homedir(), '.work', 'web.pid');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(pidFilePath(), 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readUrl(): string | null {
  try {
    const v = fs.readFileSync(urlFilePath(), 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Best-effort ping. We don't strictly need it — the PID check above is
 *  authoritative — but a 200 from /api/context confirms the server is
 *  actually serving, not just a stale process holding the port. */
async function pingsAlive(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url + 'api/context', { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function stopExisting(): boolean {
  const pid = readPid();
  if (!pid) {
    info(chalk.gray('No work web running.'));
    return false;
  }
  if (!isPidAlive(pid)) {
    info(chalk.gray(`Stale PID ${pid} — cleaning up.`));
    try { fs.unlinkSync(pidFilePath()); } catch { /* */ }
    try { fs.unlinkSync(urlFilePath()); } catch { /* */ }
    return false;
  }
  try {
    process.kill(pid);
    info(chalk.gray(`Stopped work web (PID ${pid}).`));
    try { fs.unlinkSync(pidFilePath()); } catch { /* */ }
    try { fs.unlinkSync(urlFilePath()); } catch { /* */ }
    return true;
  } catch (err) {
    info(chalk.red(`Failed to stop PID ${pid}: ${(err as Error).message}`));
    return false;
  }
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
      .option('lean', {
        type: 'boolean',
        default: false,
        hidden: true,
        describe:
          'Internal: start without dashboard-only features (Claude activity watcher + hooks). Used by `wd` when it auto-starts work web for a diff-only session.',
      }),
  handler: async (argv) => {
    if (argv.stop) {
      stopExisting();
      process.exit(0);
    }

    // Singleton enforcement. Two work web servers running at once is
    // strictly bad: they fight over `~/.work/settings.json` hooks,
    // each one holds a port, and only the most-recently-started is
    // discoverable via `web.url`. Detect a live previous instance and
    // either reuse it (open browser) or refuse to start.
    const existingPid = readPid();
    if (existingPid && isPidAlive(existingPid)) {
      const url = readUrl();
      if (url && (await pingsAlive(url))) {
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
    try { fs.unlinkSync(pidFilePath()); } catch { /* */ }
    try { fs.unlinkSync(urlFilePath()); } catch { /* */ }

    const lean = !!argv.lean || process.env.WORK_WEB_LEAN === '1';
    const handle = await startWebServer({ lean });
    try {
      fs.mkdirSync(path.dirname(urlFilePath()), { recursive: true });
      fs.writeFileSync(urlFilePath(), handle.url);
      fs.writeFileSync(pidFilePath(), String(process.pid));
    } catch { /* */ }

    info(
      chalk.gray(
        `work web running at ${handle.url}${lean ? ' (lean — diff-only mode)' : ''}`,
      ),
    );
    info(chalk.gray('Press Ctrl+C to stop. Or: `work web --stop` from another shell.'));
    if (argv.open) openUrl(handle.url);

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
      ]).catch(() => { /* best-effort */ });
    }

    const shutdown = () => {
      info(chalk.gray('\nStopping work web.'));
      try { fs.unlinkSync(urlFilePath()); } catch { /* */ }
      try { fs.unlinkSync(pidFilePath()); } catch { /* */ }
      if (!lean) {
        try { removeCommandHookSync('web', 'UserPromptSubmit'); } catch { /* */ }
        try { removeCommandHookSync('web', 'Stop'); } catch { /* */ }
      }
      handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // Windows doesn't deliver SIGTERM reliably; trap exit too so we
    // best-effort clean up our pid/url files even on abrupt deaths.
    process.on('exit', () => {
      try { fs.unlinkSync(pidFilePath()); } catch { /* */ }
      try { fs.unlinkSync(urlFilePath()); } catch { /* */ }
    });
    await new Promise(() => {});
  },
};
