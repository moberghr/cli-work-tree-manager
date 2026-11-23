import { HIGH_WATERMARK, LOW_WATERMARK } from './flow-control.js';

/**
 * The output path of one PTY, between its arriving and its clients (terminal-rendering.md, "Flow control and
 * coalescing"): what goes out as one frame, and to whom.
 *
 * - **Coalescing.** The first output after a quiet moment goes out at once (a keystroke's echo waits for nothing);
 *   what arrives in the next `COALESCE_MS` goes out as one frame (VS Code's TerminalDataBufferer, `throttleBy` 5),
 *   at most `MAX_FRAME_CHARS` of it.
 * - **Flow control.** A client that acks (flow-control.ts) has its unacknowledged characters counted. The one that
 *   holds the PTY (the registry's `holder`: the one that answers the agent) pauses it above HIGH_WATERMARK and resumes
 *   it below LOW_WATERMARK, as VS Code does with its one client, but for `PAUSE_TIMEOUT_MS` at most. Any other above
 *   HIGH_WATERMARK (and the holder past its time) is **behind**: it is sent no output, and once its acks bring it under
 *   LOW_WATERMARK it is sent the screen as it stands (`resync`) and goes live again. An agent never waits long for a
 *   view nobody may be looking at (a background tab draws once a second).
 *
 * The set of clients a frame goes to is fixed when it goes: a client that joins, falls behind or catches up has
 * what was pending sent first, so a frame is never sent twice, nor to a client whose snapshot already has it. A
 * client falls behind only right after a whole frame went to it (or, the holder, at its time-out after what was
 * pending went to it): whatever query it was chosen to answer as the output arrived reached it.
 *
 * Every frame ends at an offset: the characters of output since the PTY's entry was spawned (a restart keeps
 * counting). A reconnecting client may later ask to be sent only what it missed from there.
 */

/** After the first output of a quiet moment, what arrives within this many ms goes out as one frame (VS Code's `throttleBy`). */
export const COALESCE_MS = 5;
/** A frame grows by coalescing to at most this many characters; a chunk bigger than that (node-pty reads ≤ 64 KiB) goes alone. */
export const MAX_FRAME_CHARS = 64 * 1024;
/**
 * The longest the PTY waits for the client that holds it. A tab in front, or `work attach` in a native terminal,
 * draws 100 000 characters in a few ms to a few tens. A background tab parses in timer slices that run once a second
 * (once a minute after five): it would release each pause at its next tick, never time out, and hold the agent to
 * ~100 000 characters a second (measured: 20 MB took 159 s with a 2 s limit). Under a second, it times out on its first
 * pause or two. A client that hasn't come back by then is behind, and doesn't pause the PTY again until it is used.
 */
export const PAUSE_TIMEOUT_MS = 500;
/**
 * A client that fell behind is sent a fresh screen at most this often: each snapshot runs on the host's event loop
 * (~17 ms at the mirror's full 2000 lines), and a client slower than a flood would otherwise ask for one every few ms.
 */
export const CATCH_UP_MIN_MS = 500;

export interface PacerTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: PacerTimers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What pauses the PTY's output: its reading stops, so the agent's writes block once the PTY's buffer is full. */
export interface PtyFlow {
  pause(): void;
  resume(): void;
}

export interface PacedClient {
  /** A frame of live output, and the offset it ends at. */
  send(frame: string, end: number): void;
  /** It was behind and has caught up: send it the screen as it stands now, then live output again. */
  resync(): void;
  /** It acks what it draws. One that doesn't is sent everything, as before, and never pauses the PTY. */
  metered: boolean;
}

interface ClientState {
  readonly client: PacedClient;
  /** Characters sent to it, and acked by it. */
  sent: number;
  acked: number;
  /** Sent no live output until it catches up. */
  behind: boolean;
  /** It may pause the PTY: false once it timed out holding it, until it is used (typed in, resized) again. */
  mayPause: boolean;
  /** When it was last sent a screen (its attach, a catch-up). */
  snapshotAt: number;
  catchUp: unknown;
}

export interface PacerStats {
  sent: number;
  acked: number;
  unacked: number;
  behind: boolean;
}

export class OutputPacer<K> {
  private total = 0;
  private pending: string[] = [];
  private pendingLength = 0;
  /** The coalescing window, open from the first output of a quiet moment until one passes with nothing. */
  private window: unknown = null;
  private readonly clients = new Map<K, ClientState>();
  private paused: { by: ClientState; timer: unknown } | null = null;
  private flow: PtyFlow | null;
  private readonly timers: PacerTimers;
  private readonly holder: () => K | null;

  constructor(deps: { flow: PtyFlow | null; holder: () => K | null; timers?: PacerTimers }) {
    this.flow = deps.flow;
    this.holder = deps.holder;
    this.timers = deps.timers ?? realTimers;
  }

  /** Characters of output so far: where the next frame starts, and where a snapshot taken now stands. */
  get offset(): number {
    return this.total;
  }

  /** Whether the PTY is paused for a client now. */
  get isPaused(): boolean {
    return this.paused !== null;
  }

  /** Output arrived: sent at once if it is the first of a quiet moment, else with what follows within COALESCE_MS. */
  output(data: string): void {
    if (!data) return;
    if (this.pendingLength && this.pendingLength + data.length > MAX_FRAME_CHARS) this.flushPending();
    this.total += data.length;
    if (this.window === null) {
      this.window = this.timers.set(() => this.windowEnd(), COALESCE_MS);
      this.deliver(data);
      return;
    }
    this.pending.push(data);
    this.pendingLength += data.length;
  }

  /** Send what is pending now (the PTY ended, a client joins). */
  flush(): void {
    this.flushPending();
  }

  /** A client joins at the current offset: what arrived before it is in its snapshot and is not sent to it. */
  add(key: K, client: PacedClient): void {
    this.flushPending();
    this.clients.set(key, { client, sent: 0, acked: 0, behind: false, mayPause: true, snapshotAt: this.timers.now(), catchUp: null });
    this.evaluate();
  }

  remove(key: K): void {
    const c = this.clients.get(key);
    if (!c) return;
    if (c.catchUp !== null) this.timers.clear(c.catchUp);
    this.clients.delete(key);
    if (this.paused?.by === c) this.release();
    this.evaluate();
  }

  /** It finished drawing `chars` more characters. */
  ack(key: K, chars: number): void {
    const c = this.clients.get(key);
    if (!c || !c.client.metered || !(chars > 0)) return;
    // Never more than it was sent: an ack can't pay for output to come (VS Code floors the count at 0 the same way).
    c.acked = Math.min(c.sent, c.acked + chars);
    if (c.behind) this.scheduleCatchUp(c);
    this.evaluate();
  }

  /** It was used (typed in, resized): it may pause the PTY again, and it may hold it now. */
  used(key: K): void {
    const c = this.clients.get(key);
    if (c) c.mayPause = true;
    this.evaluate();
  }

  /** Whether it is sent live output (not behind). */
  live(key: K): boolean {
    const c = this.clients.get(key);
    return !!c && !c.behind;
  }

  stats(key: K): PacerStats | null {
    const c = this.clients.get(key);
    return c ? { sent: c.sent, acked: c.acked, unacked: c.sent - c.acked, behind: c.behind } : null;
  }

  /** The PTY's process changed (a restart) or ended (null): a pause of the old one is over. */
  setFlow(flow: PtyFlow | null): void {
    this.release();
    this.flow = flow;
    this.evaluate();
  }

  /**
   * The process ended: its last output goes out, no pause is left, and a client that is behind is sent the final
   * screen now, whatever CATCH_UP_MIN_MS says, instead of being left on a stale one (the registry tells it the PTY
   * ended once that screen is sent).
   */
  end(): void {
    this.flushPending();
    this.setFlow(null);
    for (const c of [...this.clients.values()]) {
      if (!c.behind) continue;
      if (c.catchUp !== null) this.timers.clear(c.catchUp);
      c.catchUp = null;
      this.catchUp(c);
    }
  }

  /** The entry is gone: no pause left, no timer, no client. */
  dispose(): void {
    this.release();
    this.flow = null;
    if (this.window !== null) this.timers.clear(this.window);
    this.window = null;
    for (const c of this.clients.values()) if (c.catchUp !== null) this.timers.clear(c.catchUp);
    this.clients.clear();
    this.pending = [];
    this.pendingLength = 0;
  }

  private windowEnd(): void {
    this.window = null;
    if (!this.pendingLength) return; // quiet: the next output goes at once
    this.window = this.timers.set(() => this.windowEnd(), COALESCE_MS);
    this.flushPending();
  }

  private flushPending(): void {
    if (!this.pendingLength) return;
    const frame = this.pending.length === 1 ? this.pending[0] : this.pending.join('');
    this.pending = [];
    this.pendingLength = 0;
    this.deliver(frame);
  }

  private deliver(frame: string): void {
    const end = this.total;
    for (const c of this.clients.values()) {
      if (c.behind) continue;
      c.sent += frame.length;
      try {
        c.client.send(frame, end);
      } catch {
        /* that client is gone */
      }
    }
    // Now that it was sent the whole frame (and so every query in it it may answer): one too far behind is sent no
    // more — unless it holds the PTY, which then waits for it instead.
    const holder = this.holder();
    for (const [key, c] of this.clients) {
      if (c.behind || !c.client.metered || c.sent - c.acked <= HIGH_WATERMARK) continue;
      if (key === holder && this.flow && c.mayPause) continue;
      c.behind = true;
    }
    this.evaluate();
  }

  /** Pause the PTY for its holder above HIGH_WATERMARK, resume it below LOW_WATERMARK — or when nobody holds it any more. */
  private evaluate(): void {
    const key = this.holder();
    const h = key === null ? undefined : this.clients.get(key);
    const holds = !!h && !!this.flow && h.client.metered && !h.behind && h.mayPause;
    if (this.paused) {
      if (holds && this.paused.by === h && h.sent - h.acked >= LOW_WATERMARK) return; // still waiting for it
      this.release();
    }
    if (holds && h.sent - h.acked > HIGH_WATERMARK) this.pause(h);
  }

  private pause(h: ClientState): void {
    try {
      this.flow?.pause();
    } catch {
      return; // its process is gone: nothing to wait for
    }
    this.paused = { by: h, timer: this.timers.set(() => this.timedOut(h), PAUSE_TIMEOUT_MS) };
  }

  private release(): void {
    if (!this.paused) return;
    this.timers.clear(this.paused.timer);
    this.paused = null;
    try {
      this.flow?.resume();
    } catch {
      /* its process is gone */
    }
  }

  /** The PTY waited for its holder long enough: it goes on, and the holder is behind (what was pending went to it first). */
  private timedOut(h: ClientState): void {
    if (this.paused?.by !== h) return;
    this.flushPending();
    h.behind = true;
    h.mayPause = false;
    this.release();
    this.evaluate();
  }

  private scheduleCatchUp(c: ClientState): void {
    if (c.catchUp !== null || c.sent - c.acked >= LOW_WATERMARK) return;
    const wait = c.snapshotAt + CATCH_UP_MIN_MS - this.timers.now();
    if (wait > 0) {
      c.catchUp = this.timers.set(() => {
        c.catchUp = null;
        this.catchUp(c);
      }, wait);
      return;
    }
    this.catchUp(c);
  }

  /** It caught up: what arrived meanwhile goes to the others (its snapshot has it), then it is sent the screen and live output. */
  private catchUp(c: ClientState): void {
    if (!c.behind || ![...this.clients.values()].includes(c)) return;
    this.flushPending();
    c.behind = false;
    c.snapshotAt = this.timers.now();
    try {
      c.client.resync();
    } catch {
      /* that client is gone */
    }
    this.evaluate();
  }
}
