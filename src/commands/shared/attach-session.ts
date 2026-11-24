import chalk from 'chalk';
import { WebSocket } from 'ws';
import type { WorktreeSession } from '../../core/sessions/history.js';
import { sessionIdFor } from '../../core/sessions/web-state.js';
import { spawnSpecFor } from '../../core/pty/pty-pool.js';
import { ensureHost, PtyHostClient } from '../../core/pty/pty-host-client.js';
import { resolveWorkBinPath } from '../../core/platform/work-bin.js';
import { TERMINAL_RESET } from '../../core/pty/terminal-reset.js';
import { ackFrame, withFlow } from '../../core/pty/flow-control.js';
import { sameGrid, validGrid, withGrid } from '../../core/pty/terminal-size.js';
import { attachOutput } from './attach-output.js';

// Bridges this terminal to a session in the PTY host. Shared by
// `work attach` and `work tree --host`; it lives here rather than in either
// command so commands never import each other (architecture rule).

/** Ctrl+] — detaches, leaving Claude running in the PTY host. Same key
 *  telnet uses; Claude Code doesn't bind it. */
const DETACH = '\x1d';

/** One-shot launch options `work tree --host` forwards on first spawn. */
export interface AttachSpawnOptions {
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
export async function attachSession(session: WorktreeSession, launch: AttachSpawnOptions = {}): Promise<number> {
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
    ? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null))
    : undefined;
  await host.spawn(id, {
    ...spec,
    cols,
    rows,
    fresh: launch.fresh,
    initialPrompt: launch.initialPrompt,
    env,
  });

  // Tab title = the session, so a row of Windows Terminal tabs reads as
  // a list of agents rather than ten "claude"s.
  process.stdout.write(`\x1b]0;${session.target} · ${session.branch || '(base)'}\x07`);

  // It acks what your terminal took (`?flow=1`): a terminal slower than the agent is paced, or sent the screen once it caught up.
  // It states your terminal's grid (`?cols&rows`, terminal-size.ts): the host resizes the PTY to it before it takes the
  // screen it sends first, so that screen is drawn for this terminal, and the agent's repaint for it follows as output.
  const grid = validGrid(cols, rows);
  const ws = new WebSocket(withGrid(withFlow(host.attachUrl(id), { screenOnly: true }), grid));
  const sendFrame = (frame: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const screen = attachOutput({
    write: (data, done) => process.stdout.write(data, () => done()),
    ack: (chars) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(ackFrame(chars));
    },
  });
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
      screen.output(data as Buffer);
      return;
    }
    try {
      const msg = JSON.parse(data.toString()) as {
        type?: string;
        code?: number;
        message?: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.type === 'replay') {
        // A later one (it fell behind and caught up) is only drawn: no resize, which would take the PTY's size.
        if (!screen.replay(msg.data ?? '')) return;
        replayed = true;
        // Drawn at this terminal's grid (a current host took the grid stated above): nothing to do — the PTY is at it,
        // and an agent that had to repaint for it did so as the output that follows. Drawn at another (an older host,
        // which ignores the parameters; or the terminal resized meanwhile): this terminal's grid, which makes the agent
        // repaint for it. It used to nudge the size a row and back here instead, a repaint on every attach.
        const own = validGrid(process.stdout.columns || cols, process.stdout.rows || rows);
        if (own && !sameGrid(own, validGrid(msg.cols, msg.rows))) sendFrame({ type: 'resize', ...own });
      } else if (msg.type === 'exit') {
        exitCode = msg.code ?? 0;
        message = 'Claude exited.';
      } else if (msg.type === 'error') {
        exitCode = 1;
        message = msg.message ?? 'PTY host error';
      }
    } catch {
      /* not a control frame */
    }
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
  // The agent's modes (mouse, paste, kitty keys, hidden cursor, alternate screen…) off again in your own terminal.
  if (process.stdout.isTTY) process.stdout.write(TERMINAL_RESET);
  if (message) process.stderr.write('\r\n' + chalk.gray(message) + '\r\n');
  // Let the event loop drain instead of process.exit(): on Windows,
  // exiting while a fetch's AbortSignal.timeout is still pending trips a
  // libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, exit code
  // 0xC0000409) — i.e. a quick detach crashed.
  stdin.destroy();
  return exitCode;
}
