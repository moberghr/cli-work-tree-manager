import type { Grid } from './terminal-size.js';
import type { ResumePoint } from './resume.js';

/**
 * The last of a PTY's raw output, kept so a client that reconnects, or that fell behind and caught up, is sent only what
 * it missed (terminal-rendering.md, "Reattach where you left off" and "Flow control and coalescing"). Pure.
 *
 * 256 Ki characters. A client falls behind only once it has more than HIGH_WATERMARK (100 000) outstanding, so what it
 * misses of a burst is the burst less that: 256 Ki covers a burst of ~360 000 characters, about the 5 000 lines a tab
 * keeps (VIEW_SCROLLBACK) of ~72-character coloured lines (a 3 000-line burst of them is 218 000 characters, 230 KB) —
 * past that, the tab would push most of it out of its own scrollback anyway. What a resume or a catch-up sends from here is never
 * counted against a client's flow (as a screen isn't): it is at most this, about a catch-up screen of REPLAY_SCROLLBACK
 * (~410 KiB at 200 columns), and costs the host no copy it doesn't already hold but the one string sent. At most
 * 512 KiB per PTY (two bytes a character in the worst case), against the mirror's ~6–11.5 MiB: 10 MiB for 20 PTYs.
 * Longer than that, a client gets a screen.
 */
export const RESUME_TAIL_CHARS = 256 * 1024;

/**
 * The last `max` characters of a stream, and where they stand in it. The cut at its start may fall anywhere (inside an
 * escape sequence, a surrogate pair, a synchronized frame): nothing is ever sent from there, only from a client's own
 * offset, which is where its terminal's parser stands.
 */
export class OutputTail {
  private chunks: string[] = [];
  /** The first chunk still held (`chunks` is compacted now and then, not shifted each time). */
  private head = 0;
  private held = 0;
  private total = 0;

  constructor(private readonly max = RESUME_TAIL_CHARS) {}

  /** The offset of the first character held. */
  get start(): number {
    return this.total - this.held;
  }

  /** The offset after the last character: everything up to here has arrived. */
  get end(): number {
    return this.total;
  }

  push(text: string): void {
    if (!text) return;
    this.total += text.length;
    this.chunks.push(text);
    this.held += text.length;
    while (this.held > this.max) {
      const first = this.chunks[this.head];
      const over = this.held - this.max;
      if (first.length <= over) {
        this.head++;
        this.held -= first.length;
      } else {
        this.chunks[this.head] = first.slice(over);
        this.held -= over;
      }
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  /** Everything from `offset` to the end; null when it isn't all held (too old, or ahead of the stream). */
  since(offset: number): string | null {
    if (!Number.isSafeInteger(offset) || offset < this.start || offset > this.total) return null;
    let skip = offset - this.start;
    const out: string[] = [];
    for (let i = this.head; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (skip >= c.length) {
        skip -= c.length;
        continue;
      }
      out.push(skip ? c.slice(skip) : c);
      skip = 0;
    }
    return out.join('');
  }

  /** Hold nothing more (the entry is gone); the count stays. */
  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.held = 0;
  }
}

/** Why a client is sent a screen rather than what it missed. */
export type ResumeRefusal =
  /** Another stream: another process under this id, a host started again, or not this host's at all. */
  | 'stream'
  /** Its terminal's grid isn't the PTY's (or the grid it states to take isn't its own): drawn there, the output would be laid out for another grid. */
  | 'grid'
  /** The PTY's grid changed after its offset: the mirror and the agent reflowed and repainted for another grid meanwhile. */
  | 'resized'
  /** What it missed is no longer all held. */
  | 'too-old'
  /** It says it has more than there is. */
  | 'ahead'
  /** Its offset falls between the two halves of a surrogate pair: not where any frame ends. */
  | 'split'
  /** The PTY is exiting, restarting, halted or being redrawn. */
  | 'busy';

/** What the registry knows of a PTY when a client joins it. */
export interface ResumeTarget {
  stream: string;
  /** Its grid now, and before this attach resized it (a client that states a grid takes it as it attaches). */
  grid: Grid;
  gridBefore: Grid;
  /** The offset its grid last changed at (a client's resize, a redraw's jiggle). */
  gridAt: number;
  busy: boolean;
}

/**
 * What a reconnecting client at `at` is sent instead of a screen: the output it missed, or why it gets a screen. Any
 * doubt is a screen. `stated`: the grid it asked to take as it attached, if any.
 */
export function resumeFrom(
  at: ResumePoint,
  target: ResumeTarget,
  tail: OutputTail,
  stated?: Grid | null,
): { missed: string } | { refused: ResumeRefusal } {
  if (at.stream !== target.stream) return { refused: 'stream' };
  if (target.busy) return { refused: 'busy' };
  const same = (g: Grid) => g.cols === at.cols && g.rows === at.rows;
  if (!same(target.grid) || !same(target.gridBefore) || (stated && !same(stated))) return { refused: 'grid' };
  return continueFrom(at.offset, target, tail);
}

/**
 * What a client that has drawn this stream up to `offset` is sent to go on from there: the output since, when it is all
 * held and nothing since makes it unsafe (an agent busy, a resize after it, an offset inside a surrogate pair), else why
 * not. A reconnecting client after its stream and grid are checked (`resumeFrom`); a client that fell behind as it
 * catches up, at the offset it was sent output up to (pty-registry.ts `resync`): that output is in order on its socket,
 * so its screen will stand there, drawn at the grid it draws live output at.
 */
export function continueFrom(
  offset: number,
  target: Pick<ResumeTarget, 'gridAt' | 'busy'>,
  tail: OutputTail,
): { missed: string } | { refused: ResumeRefusal } {
  if (target.busy) return { refused: 'busy' };
  if (offset > tail.end) return { refused: 'ahead' };
  if (target.gridAt > offset) return { refused: 'resized' };
  const missed = tail.since(offset);
  if (missed === null) return { refused: 'too-old' };
  const first = missed.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) return { refused: 'split' };
  return { missed };
}
