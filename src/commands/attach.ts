import path from 'node:path';
import chalk from 'chalk';
import { WebSocket } from 'ws';
import type { CommandModule } from 'yargs';
import { findSession, loadHistory, type WorktreeSession } from '../core/history.js';
import { sessionIdFor } from '../core/web-state.js';
import { spawnSpecFor } from '../core/pty-pool.js';
import { ensureHost, PtyHostClient } from '../core/pty-host-client.js';
import { resolveWorkBinPath } from './diff.js';

/** Ctrl+] — detaches, leaving Claude running in the PTY host. Same key
 *  telnet uses; Claude Code doesn't bind it. */
const DETACH = '\x1d';

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** The session whose worktree contains `cwd` (deepest match wins). */
export function sessionForCwd(
  sessions: WorktreeSession[],
  cwd: string,
): WorktreeSession | null {
  const here = norm(cwd);
  let best: { s: WorktreeSession; len: number } | null = null;
  for (const s of sessions) {
    for (const p of s.paths) {
      const roots = s.isGroup ? [p, path.dirname(p)] : [p];
      for (const root of roots) {
        const r = norm(root);
        if ((here === r || here.startsWith(r + path.sep)) && (!best || r.length > best.len)) {
          best = { s, len: r.length };
        }
      }
    }
  }
  return best?.s ?? null;
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
    const branch = (argv.branch as string | undefined) ?? '';
    const session = target
      ? (findSession(sessions, target, branch) ?? null)
      : sessionForCwd(sessions, process.cwd());
    if (!session) {
      console.error(
        chalk.red(
          target
            ? `No session for ${target}${branch ? ` ${branch}` : ''}. Create it with \`work tree ${target} ${branch}\`.`
            : 'The current directory is not inside a work session. Pass <target> [branch].',
        ),
      );
      process.exit(1);
    }
    const spec = spawnSpecFor(session);
    if (!spec) {
      console.error(chalk.red('Session has no worktree path.'));
      process.exit(1);
    }

    const id = sessionIdFor(session);
    const host = new PtyHostClient(await ensureHost(resolveWorkBinPath(process.argv[1])));
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 32;
    await host.spawn(id, { ...spec, cols, rows });

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
          process.stdout.write('[2J[H' + (msg.data ?? ''));
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
    process.exitCode = exitCode;
  },
};
