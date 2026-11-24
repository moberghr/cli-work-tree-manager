/**
 * Flow control between the PTY host and a client that draws its output (terminal-rendering.md, "Flow control and
 * coalescing"). Pure and import-free: the browser's Terminal tab, `work attach` and the host share it.
 *
 * A client that acks says so on its attach address (`?flow=1`), then tells the host every `ACK_EVERY` characters
 * it has finished drawing (`{ type: 'ack', chars }`). The unit is the host's: the output's characters as JavaScript
 * counts them (UTF-16 code units, VS Code's unit). A client receives UTF-8 bytes and counts them with `utf16Length`,
 * without decoding. The numbers are VS Code's (`FlowControlConstants`, platform/terminal/common/terminal.ts).
 */

/** Unacknowledged characters above which a client is too far behind: the PTY waits for it, or it is sent no more. */
export const HIGH_WATERMARK = 100_000;
/** Unacknowledged characters below which it has caught up. */
export const LOW_WATERMARK = 5_000;
/** A client acks once this many characters are drawn. At most LOW_WATERMARK, or a client that stopped short of it would never count as caught up. */
export const ACK_EVERY = 5_000;
/** The query parameter a client that acks adds to its attach address: an older host ignores it (and its acks). */
export const FLOW_PARAM = 'flow';
/**
 * `catchup=screen`: the client's catch-up screens (it fell behind) are the screen only, without the scrollback.
 * `work attach` asks for it: its native terminal keeps your history, which a catch-up must not clear or fill again.
 * An older host ignores it and sends the scrollback too (drawn again into your history, never cleared).
 */
export const CATCH_UP_PARAM = 'catchup';

/** `url` with the flow parameter added: this client acks. `screenOnly`: its catch-up screens without the scrollback. */
export function withFlow(url: string, opts: { screenOnly?: boolean } = {}): string {
  const params = `${FLOW_PARAM}=1${opts.screenOnly ? `&${CATCH_UP_PARAM}=screen` : ''}`;
  return `${url}${url.includes('?') ? '&' : '?'}${params}`;
}

/**
 * How many UTF-16 code units the UTF-8 `bytes` decode to: one per sequence, two for a 4-byte one (a surrogate pair).
 * The host's output is a JavaScript string sent as UTF-8, and a string's length survives that round trip (a lone
 * surrogate becomes U+FFFD, also one unit). Split anywhere, the parts still add up: a sequence is counted at its lead byte.
 */
export function utf16Length(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b & 0xc0) !== 0x80) n += b >= 0xf0 ? 2 : 1;
  }
  return n;
}

/** The ack frame a client sends (ClientFrame `ack`). */
export function ackFrame(chars: number): string {
  return JSON.stringify({ type: 'ack', chars });
}

/**
 * Counts the characters a client finished drawing, and sends an ack once `every` of them are (VS Code's
 * CharCountAckSize). What is left below `every` is never sent; that is why `every` is at most LOW_WATERMARK.
 */
export class AckCounter {
  private pending = 0;
  constructor(
    private readonly send: (chars: number) => void,
    private readonly every = ACK_EVERY,
  ) {}

  drawn(chars: number): void {
    if (!(chars > 0)) return;
    this.pending += chars;
    if (this.pending < this.every) return;
    const n = this.pending;
    this.pending = 0;
    this.send(n);
  }
}
