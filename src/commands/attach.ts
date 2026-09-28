import path from 'node:path';
import chalk from 'chalk';
import { WebSocket } from 'ws';
import type { CommandModule } from 'yargs';
import { findSession, loadHistory, type WorktreeSession } from '../core/history.js';
import { loadConfig, type WorkConfig } from '../core/config.js';
import { sessionIdFor } from '../core/web-state.js';
import { findSessionForCwd } from '../core/pending-delivery.js';
import { spawnSpecFor } from '../core/pty-pool.js';
import { ensureHost, PtyHostClient } from '../core/pty-host-client.js';
import { resolveWorkBinPath } from './diff.js';

/** Ctrl+] — detaches, leaving Claude running in the PTY host. Same key
 *  telnet uses; Claude Code doesn't bind it. */
const DETACH = '\x1d';

/**
 * `work attach <target>` with no branch = the target's base checkout. Those
 * sessions are stored under whatever branch the base repo had checked out
 * (`work tree api` → branch "main"), so match by path, not by an empty
 * branch; if it has been used on several branches, the latest wins.
 */
export function baseCheckoutSession(
  sessions: WorktreeSession[],
  target: string,
  config: Pick<WorkConfig, 'repos'> | null,
): WorktreeSession | null {
  const repoPath = config?.repos[target];
  if (!repoPath) return null;
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const matches = sessions
    .filter((s) => s.target === target && !s.isGroup && s.paths[0] && norm(s.paths[0]) === norm(repoPath))
    .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
  return matches[0] ?? null;
}

export const attachCommand: CommandModule = {
  command: 'attach [target] [branch]',
  aliases: ['a'],
  describe:
    'Attach this terminal to a session\'s Claude in the PTY host (Ctrl+] detaches; Claude keeps running)',
  builder: (yargs) =>
    yargs
      .positional('target', { type: 'string', describe: 'Repo alias or group (default: session for the current directory)' })
      .positional('branch', { type: 'string', describe: 'Branch (default: the target\'s base checkout)' }),
  handler: async (argv) => {
    const sessions = loadHistory();
    const target = argv.target as string | undefined;
    const branch = argv.branch as string | undefined;
    const session = target
      ? branch
        ? (findSession(sessions, target, branch) ?? null)
        : baseCheckoutSession(sessions, target, loadConfig())
      : findSessionForCwd(process.cwd(), sessions);
    if (!session) {
      console.error(
        chalk.red(
          target
            ? `No session for ${target}${branch ? ` ${branch}` : ' (base checkout)'}. Create it with \`work tree ${target}${branch ? ` ${branch}` : ''}\`.`
            : 'The current directory is not inside a work session. Pass <target> [branch].',
        ),
      );
      process.exit(1);
    }
    // Spawning here too (session not running yet) uses this shell's env.
    process.exitCode = await attachSession(session, { forwardEnv: true });
  },
};

/** One-shot launch options `work tree --host` forwards on first spawn. */
export interface AttachSpawnOptions {
  unsafe?: boolean;
  fresh?: boolean;
  initialPrompt?: string;
  /** Forward this process's environment (PATH, AWS_PROFILE, WT_SESSION…)
   *  so the tool sees the shell it was launched from. */
  forwardEnv?: boolean;
}

/**
 * Spawn the session's tool in the PTY host if it isn't running, then bridge
 * this terminal to it until the tool exits or the user detaches (Ctrl+]).
 * Shared by `work attach` and `work tree --host`. Resolves to the exit code
 * the caller should report; never calls process.exit (see the end).
 */
export async function attachSession(
  session: WorktreeSession,
  launch: AttachSpawnOptions = {},
): Promise<number> {
  const spec = spawnSpecFor(session);
  if (!spec) {
    console.error(chalk.red('Session has no worktree path.'));
    return 1;
  }

  const id = sessionIdFor(session);
  const host = new PtyHostClient(await ensureHost(resolveWorkBinPath(process.argv[1])));
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const existing = await host.get(id);
  if (existing && !existing.exited && (launch.initialPrompt || launch.fresh)) {
    // Spawn is idempotent — a live session keeps its conversation.
    console.error(
      chalk.yellow(
        `Session already running in the PTY host — attaching to it; ${launch.initialPrompt ? '--prompt' : '--fresh'} not applied.`,
      ),
    );
  }
  const env = launch.forwardEnv
    ? Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] != null),
      )
    : undefined;
  await host.spawn(id, {
    ...spec,
    cols,
    rows,
    unsafe: launch.unsafe,
    fresh: launch.fresh,
    initialPrompt: launch.initialPrompt,
    env,
  });

  // Tab title = the session, so a row of Windows Terminal tabs reads as
  // a list of agents rather than ten "claude"s.
  process.stdout.write(`\x1b]0;${session.target} · ${session.branch || '(base)'}\x07`);

  const ws = new WebSocket(host.attachUrl(id));
  const sendFrame = (frame: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  let exitCode = 0;
  let message = '';

  const stdin = process.stdin;
  const restoreTty = () => {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  ws.on('open', () => {
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', (buf: Buffer) => {
      const data = buf.toString('utf-8');
      if (data === DETACH) {
        message = 'Detached — Claude keeps running. `work attach` to come back.';
        ws.close(1000);
        return;
      }
      // Held until the replay is drawn (it's always the first frame).
      if (replayed) sendFrame({ type: 'input', data });
    });
  });
  let replayed = false;
  const onResize = () => {
    sendFrame({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows });
  };
  process.stdout.on('resize', onResize);
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      process.stdout.write(data as Buffer);
      return;
    }
    try {
      const msg = JSON.parse(data.toString()) as {
        type?: string;
        code?: number;
        message?: string;
        data?: string;
      };
      if (msg.type === 'replay') {
        process.stdout.write('\x1b[2J\x1b[H' + (msg.data ?? ''));
        replayed = true;
        // Nudge the size by one row and back: forces a SIGWINCH so Claude's
        // TUI redraws for this terminal's grid — the snapshot was drawn
        // for whichever client sized the PTY last.
        const c = process.stdout.columns || cols;
        const r = process.stdout.rows || rows;
        sendFrame({ type: 'resize', cols: c, rows: Math.max(2, r - 1) });
        sendFrame({ type: 'resize', cols: c, rows: r });
      } else if (msg.type === 'exit') {
        exitCode = msg.code ?? 0;
        message = 'Claude exited.';
      } else if (msg.type === 'error') {
        exitCode = 1;
        message = msg.message ?? 'PTY host error';
      }
    } catch { /* not a control frame */ }
  });
  await new Promise<void>((resolve) => {
    ws.on('close', () => resolve());
    ws.on('error', (err) => {
      exitCode = 1;
      message = `Lost the PTY host: ${err.message}`;
      resolve();
    });
  });
  restoreTty();
  process.stdout.off('resize', onResize);
  if (message) process.stderr.write('\r\n' + chalk.gray(message) + '\r\n');
  // Let the event loop drain instead of process.exit(): on Windows,
  // exiting while a fetch's AbortSignal.timeout is still pending trips a
  // libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, exit code
  // 0xC0000409) — i.e. a quick detach crashed.
  stdin.destroy();
  return exitCode;
}
