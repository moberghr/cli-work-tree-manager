import { AckCounter, utf16Length } from '../../core/pty/flow-control.js';

/**
 * Before every screen: the screen cleared, your terminal's history above it kept — never `CSI 3 J`, which would erase
 * your shell's history from before the attach. A screen sent mid-session (this terminal fell behind and caught up:
 * output-pacer.ts) is the screen only (`withFlow(…, { screenOnly })`), so it adds nothing to that history; an older host
 * sends its scrollback too, drawn into your history again (a copy, nothing lost).
 */
export const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export interface AttachOutput {
  /** PTY output: written, and acked once your terminal took it. */
  output(data: Uint8Array): void;
  /** A replay frame. True for the first one: the caller then nudges the size and starts sending input. A later one is only drawn. */
  replay(data: string): boolean;
}

/**
 * What `work attach` does with what the PTY host sends it: output written to your terminal and acked once written
 * (`process.stdout.write`'s callback: flow-control.ts), and each replay drawn over a cleared screen (a later one: it
 * fell behind). `ack` sends the ack frame.
 */
export function attachOutput(io: { write(data: Uint8Array | string, done: () => void): void; ack(chars: number): void }): AttachOutput {
  let replayed = false;
  const acks = new AckCounter((chars) => io.ack(chars));
  return {
    output(data) {
      const chars = utf16Length(data);
      io.write(data, () => acks.drawn(chars));
    },
    replay(data) {
      const first = !replayed;
      replayed = true;
      io.write(CLEAR_SCREEN + data, () => {});
      return first;
    },
  };
}
