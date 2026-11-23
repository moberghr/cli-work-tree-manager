import type { StreamSignal } from './stream-status.js';
import type { TerminalColors } from './terminal-colors.js';

/** Which snapshot: with the scrollback (the default), or the screen only (`scrollback: false`). */
export interface SnapshotOptions {
  /**
   * False: the screen only, no lines above it — a catch-up screen for a native terminal (`work attach`), whose own
   * scrollback holds your shell's history and, already, the agent's. The state after it is the same either way.
   */
  scrollback?: boolean;
}

/** How the mirror answers the agent's queries in the output it is written while no client is attached (`answerQueries`). */
export interface MirrorAnswers {
  /** Whether the mirror answers the queries in output written now: decided as it arrives, not when it is parsed. */
  now(): boolean;
  /** Where the answers go: the PTY. */
  send(reply: string): void;
  /** The colours colour queries are answered with. */
  colors: Pick<TerminalColors, 'reply'>;
}

/**
 * The PTY host's copy of a terminal's screen, whatever keeps it: what PtySession feeds the PTY's output to, and what a
 * client attaching is sent first (`snapshot`: plain VT bytes, which xterm.js and a native terminal both restore).
 * Two engines: ScreenMirror (@xterm/headless, the default) and GhosttyMirror (libghostty-vt), picked by `terminalEngine` (create-mirror.ts).
 */
export interface TerminalMirror {
  /** Output from the PTY; `done` runs once it is parsed, in the order written. */
  write(data: string, done?: () => void): void;
  /** In order with the writes around it. */
  resize(cols: number, rows: number): void;
  /** Answer the agent's queries in output written while `answers.now()` says so. */
  answerQueries(answers: MirrorAnswers): void;
  /** The screen (and scrollback) and the state after it, as escape sequences; '' if it can't be taken. */
  snapshot(opts?: SnapshotOptions): string;
  /** snapshot(), once everything written so far is parsed. */
  snapshotSettled(opts?: SnapshotOptions): Promise<string>;
  /** The visible screen as plain text, one line per row. */
  screenText(): string;
  /** What the agent last said about itself in-band (stream-status.ts). */
  streamSignal(): StreamSignal | null;
  dispose(): void;
}
