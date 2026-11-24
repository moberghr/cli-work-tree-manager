/**
 * Synchronized output (DEC private mode 2026, terminal-rendering.md "Synchronized output"): an agent wraps each repaint
 * in `CSI ? 2026 h` … `CSI ? 2026 l` so the terminal shows whole frames. The PTY host follows those marks AS THE OUTPUT
 * ARRIVES — before its screen copy has parsed it (that parse is asynchronous) — to keep each frame whole on its way to
 * the clients (output-pacer.ts) and to take a snapshot only between frames (pty-session.ts cuts its output at each
 * frame's end for that).
 *
 * Only the set and reset of 2026 are recognised, alone or among other modes (`CSI ? 2026 ; 25 h`), wherever a chunk
 * cuts them: the scanner keeps its place in a sequence across chunks. A second set inside a frame changes nothing, a
 * reset with no frame open is nothing, and RIS (`ESC c`) ends a frame, as each does in xterm.js 6. A query
 * (`CSI ? 2026 $ p`) is not a set. Pure and import-free.
 */

/** Begin and end of a synchronized update (BSU / ESU), as agents write them. */
export const BSU = '\x1b[?2026h';
export const ESU = '\x1b[?2026l';

/** DEC private mode 2026: synchronized output (the Terminal tab's repaint-scroll.ts follows it too). */
export const SYNC_MODE = 2026;
/** Longer parameters than this are no mode list an agent writes: the sequence is dropped (bounded state). */
const MAX_PARAMS = 64;

/** Where a sequence that opened or closed a frame ends in a chunk (`at`: just past its final character), and the state after it. */
export interface SyncChange {
  at: number;
  open: boolean;
}

/** Where the scanner is in a sequence: outside one, after ESC, after ESC [, among a private mode's parameters. */
const GROUND = 0;
const ESCAPE = 1;
const CSI = 2;
const PRIVATE = 3;

export class SyncScanner {
  /** A frame is open: a set was seen and no reset since. */
  open = false;
  private state = GROUND;
  private params = '';

  /** Follow `chunk`: the places in it where a frame opened or closed, in order. */
  feed(chunk: string): SyncChange[] {
    const changes: SyncChange[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.state === GROUND) {
        const esc = chunk.indexOf('\x1b', i);
        if (esc < 0) break;
        this.state = ESCAPE;
        i = esc + 1;
        continue;
      }
      const c = chunk[i];
      if (this.state === ESCAPE) {
        if (c === '[') this.state = CSI;
        else {
          this.state = GROUND;
          if (c === 'c')
            this.change(false, i + 1, changes); // RIS
          else if (c === '\x1b') this.state = ESCAPE;
        }
      } else if (this.state === CSI) {
        if (c === '?') {
          this.state = PRIVATE;
          this.params = '';
        } else this.state = c === '\x1b' ? ESCAPE : GROUND;
      } else if ((c >= '0' && c <= '9') || c === ';' || c === ':') {
        this.params += c;
        if (this.params.length > MAX_PARAMS) this.state = GROUND;
      } else {
        this.state = c === '\x1b' ? ESCAPE : GROUND;
        if ((c === 'h' || c === 'l') && this.params.split(';').some((p) => Number(p.split(':')[0]) === SYNC_MODE))
          this.change(c === 'h', i + 1, changes);
      }
      i++;
    }
    return changes;
  }

  /** Start again with no frame open (the PTY's process changed). */
  reset(): void {
    this.open = false;
    this.state = GROUND;
    this.params = '';
  }

  private change(open: boolean, at: number, changes: SyncChange[]): void {
    if (open === this.open) return;
    this.open = open;
    changes.push({ at, open });
  }
}

/** `chunk` cut just past each place a frame CLOSES (so a snapshot can be taken between two frames); `[chunk]` when none does. */
export function cutAtFrameEnds(scanner: SyncScanner, chunk: string): string[] {
  const ends = scanner.feed(chunk).filter((c) => !c.open && c.at < chunk.length);
  if (!ends.length) return [chunk];
  const pieces: string[] = [];
  let from = 0;
  for (const { at } of ends) {
    pieces.push(chunk.slice(from, at));
    from = at;
  }
  pieces.push(chunk.slice(from));
  return pieces;
}
