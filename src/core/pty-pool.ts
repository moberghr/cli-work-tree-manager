import { PtySession } from '../tui/session.js';
import { findSession } from './web-state.js';
import { loadConfig } from './config.js';
import { getAiTool } from './ai-launcher.js';

export interface PooledPty {
  session: PtySession;
  readonly sessionId: string;
  /** Replay buffer of recent PTY output, sent to each new attaching client. */
  replay(): string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Subscribe to live PTY output. Returns an unsubscribe disposer. */
  subscribe(cb: (data: string) => void): () => void;
  dispose(): void;
  isExited(): boolean;
}

/**
 * Per-session PTY pool. Lazily spawns Claude (or the configured AI tool)
 * for a session the first time someone attaches a terminal. PTYs survive
 * browser disconnects — only `dispose()` (server shutdown) kills them.
 *
 * Each PTY has an in-memory replay buffer; a fresh WS attach replays it so
 * the user sees the existing scrollback rather than a blank screen.
 */
const pool = new Map<string, PooledPty>();
const REPLAY_MAX = 64 * 1024;

export function getOrCreatePty(sessionId: string): PooledPty | null {
  const existing = pool.get(sessionId);
  if (existing && !existing.isExited()) return existing;
  if (existing) pool.delete(sessionId);

  const session = findSession(sessionId);
  if (!session) return null;

  const cwd = session.paths[0];
  if (!cwd) return null;

  const config = loadConfig() ?? {};
  const tool = getAiTool(config);
  const pty = new PtySession(cwd, 120, 32, undefined, {
    tool,
    resume: true,
  });

  const subscribers = new Set<(data: string) => void>();
  let replayBuf = '';
  pty.setOutputHandler((data) => {
    replayBuf += data;
    if (replayBuf.length > REPLAY_MAX) {
      replayBuf = replayBuf.slice(replayBuf.length - REPLAY_MAX);
    }
    for (const cb of subscribers) {
      try { cb(data); } catch { /* */ }
    }
  });

  const entry: PooledPty = {
    session: pty,
    sessionId,
    replay: () => replayBuf,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    dispose: () => {
      subscribers.clear();
      pty.dispose();
      pool.delete(sessionId);
    },
    isExited: () => pty.exited,
  };
  pool.set(sessionId, entry);
  return entry;
}

/** Side-effect-free check: does an active (non-exited) PTY exist for this
 *  session? Used by session-meta to compute the "running/idle" badge. */
export function peekPty(sessionId: string): boolean {
  const existing = pool.get(sessionId);
  return !!existing && !existing.isExited();
}

export function disposeAllPtys(): void {
  for (const p of pool.values()) p.dispose();
  pool.clear();
}
