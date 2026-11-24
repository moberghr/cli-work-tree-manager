import { validGrid } from './terminal-size.js';

/**
 * Reattach where a client left off (terminal-rendering.md, "Reattach where you left off"). Pure; the Terminal tab and
 * the PTY host share it.
 *
 * Every screen the host sends (the `replay` frame) says which output stream it belongs to (`stream`: one per PTY entry
 * in one host, so a new spawn under the same id after the entry ended, or a host started again, is another stream) and
 * the offset it stands at (`offset`: characters of output since the entry was spawned, the pacer's unit, UTF-16 code
 * units). A restart or halt of its agent in place keeps the entry, and so the stream and the count: the clients attached
 * through it are sent the new process's output as it continues the old one's, with no screen in between, and a client
 * resuming across it is sent the same characters from its offset (pty-registry.test.ts, "across a restart"). Live
 * output follows in frames that are contiguous slices of that output, so a client knows its offset without any stamp
 * on them: the screen's offset plus what it was sent since (`utf16Length` of each binary frame, flow-control.ts).
 *
 * Reconnecting, a client that kept its screen states `?resume=<stream>-<offset>-<cols>x<rows>`: it has drawn
 * everything of that stream up to that offset, and its terminal is that grid. If the host can prove that sending what
 * came since is all it needs, it sends that (`replay` with `resumed: true`) and no screen; otherwise a screen as on
 * any attach. Absent, or from an older host or client, nothing changes: a screen.
 */

/** The attach address's parameter a reconnecting client states its position in. An older host ignores it. */
export const RESUME_PARAM = 'resume';

/** Where a client stands in a PTY's output: it has drawn all of `stream` up to `offset`, at this grid. */
export interface ResumePoint {
  stream: string;
  offset: number;
  cols: number;
  rows: number;
}

/** A stream id: what the host makes (pty-registry.ts), hex. */
const STREAM = /^[0-9a-f]{8,64}$/;
const FORMAT = /^([0-9a-f]{8,64})-(\d{1,15})-(\d{1,4})x(\d{1,4})$/;

export function isStreamId(s: unknown): s is string {
  return typeof s === 'string' && STREAM.test(s);
}

/** `url` with the client's position added (`?resume=…`). */
export function withResume(url: string, at: ResumePoint | null | undefined): string {
  if (!at) return url;
  const value = `${at.stream}-${at.offset}-${at.cols}x${at.rows}`;
  return `${url}${url.includes('?') ? '&' : '?'}${RESUME_PARAM}=${value}`;
}

/** The position stated on an attach address, or null when there is none or it isn't one (then: a screen). */
export function resumeFromParams(params: URLSearchParams): ResumePoint | null {
  const m = FORMAT.exec(params.get(RESUME_PARAM) ?? '');
  if (!m) return null;
  const offset = Number(m[2]);
  const grid = validGrid(Number(m[3]), Number(m[4]));
  if (!Number.isSafeInteger(offset) || !grid) return null;
  return { stream: m[1], offset, cols: grid.cols, rows: grid.rows };
}

/** What a `replay` frame says about the stream (fields a host from before sends none of). */
export interface ReplayPosition {
  stream?: unknown;
  offset?: unknown;
  resumed?: unknown;
}

/**
 * A client's position in the PTY's output, as it receives it: set by each `replay` frame (a screen, or what it missed),
 * moved on by each binary frame. Unknown (null) when the host said nothing of it (an older host): then the client
 * never asks to resume.
 */
export class StreamPosition {
  private stream: string | null = null;
  private at = 0;

  /** A `replay` frame: it stands at its offset now (a screen replaces what was drawn; what was missed continues it). */
  replay(msg: ReplayPosition): void {
    const ok = isStreamId(msg.stream) && typeof msg.offset === 'number' && Number.isSafeInteger(msg.offset) && msg.offset >= 0;
    this.stream = ok ? (msg.stream as string) : null;
    this.at = ok ? (msg.offset as number) : 0;
  }

  /** A frame of live output, `chars` long in the host's unit (`utf16Length` of its bytes). */
  output(chars: number): void {
    if (this.stream !== null && chars > 0) this.at += chars;
  }

  /** Where it stands, at its terminal's grid; null when unknown. */
  point(cols: number, rows: number): ResumePoint | null {
    if (this.stream === null) return null;
    const grid = validGrid(cols, rows);
    return grid ? { stream: this.stream, offset: this.at, cols: grid.cols, rows: grid.rows } : null;
  }

  /** Forget it (the screen will be replaced whatever the host says: a fresh terminal). */
  forget(): void {
    this.stream = null;
    this.at = 0;
  }
}
