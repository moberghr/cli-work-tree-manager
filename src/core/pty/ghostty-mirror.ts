import { EXTRA, GhosttyTerminal, type GridPoint, type NativeProgram } from './ghostty/terminal.js';
import type { MirrorAnswers, SnapshotOptions, TerminalMirror } from './mirror.js';
import { REPLAY_SCROLLBACK } from './scrollback.js';
import { StreamStatus, type ProgramKind, type ProgramRecord, type ProgramState, type StreamSignal } from './stream-status.js';
import type { WindowsPty } from './terminal-size.js';
import { translateReplies } from './ghostty/replies.js';

const ESC = '\x1b';
const CSI = '\x1b[';
/** The same preamble as ScreenMirror's (screen-mirror.ts `START`): the normal screen, cleared, DECSTR's defaults. */
const START = '\x1b7\x1b[?1049l\x1b[H\x1b[2J\x1b[!p\x1b[0m';
const ENTER_ALT = '\x1b[?1049h\x1b[H';
/** CAN: ends whatever sequence a copy's parser was in the middle of, so what is written to it next is read whole. */
const CAN = '\x18';
const ASK_CURSOR_STYLE = `${ESC}P$q q${ESC}\\`;
const ASK_REGION = `${ESC}P$qr${ESC}\\`;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const MOUSE_PROTOCOLS = [9, 1000, 1002, 1003];
const MOUSE_ENCODINGS = [1005, 1006, 1015, 1016];
/** Modes with a universal default: stated on and off alike. */
const BOTH_WAYS = [1, 7, 25, 45, 1004, 2004];
/** What the formatter writes after a cell (`tail`): modifyOtherKeys, the pen, the hyperlink, DECSCA, the charsets. */
const TAIL = EXTRA.KEYBOARD | EXTRA.STYLE | EXTRA.HYPERLINK | EXTRA.PROTECTION | EXTRA.CHARSETS;
/** libghostty's DECSCUSR for "never set" (and for 0): a steady block. */
const DEFAULT_CURSOR_STYLE = 2;

// The answers as xterm.js would give them (moved to ghostty/replies.ts: the browser's ghostty engine answers the same).
export { translateReply, translateReplies } from './ghostty/replies.js';

const PROGRAM_STATE: readonly (ProgramState | undefined)[] = ['idle', 'working', 'done', 'blocked', 'error'];
const PROGRAM_CLEAR = 5;
const PROGRAM_KIND: readonly (ProgramKind | undefined)[] = [undefined, 'permission', 'question', 'auth'];
const APP_REX = /^[A-Za-z0-9_.+-]{1,32}$/;

/** An OSC 7501 report as libghostty parsed it, as stream-status.ts's `parseProgramStatus` would have returned it. */
export function programReport(s: NativeProgram): ProgramRecord | { state: 'clear'; id: string } | undefined {
  if (s.state === PROGRAM_CLEAR) return { state: 'clear', id: s.id };
  const state = PROGRAM_STATE[s.state];
  if (!state) return undefined;
  const record: ProgramRecord = { id: s.id, state };
  const kind = PROGRAM_KIND[s.kind];
  if (state === 'blocked' && kind) record.kind = kind;
  if ((state === 'working' || state === 'blocked') && s.progress >= 0 && s.progress <= 100) record.progress = s.progress;
  if (APP_REX.test(s.app)) record.app = s.app;
  if (s.message) record.message = s.message;
  return record;
}

const cup = (row: number, col: number): string => `${CSI}${row + 1};${col + 1}H`;
const decModes = (modes: number[], final: 'h' | 'l'): string => (modes.length ? `${CSI}?${modes.join(';')}${final}` : '');

interface Region {
  top: number;
  bottom: number;
}
interface Cursor {
  x: number;
  y: number;
  pendingWrap: boolean;
}

/** DECSTBM from a DECRQSS reply, 0-based; null for the whole screen (or no reply). */
function parseRegion(reply: string, rows: number): Region | null {
  const m = /^\x1bP1\$r(\d+);(\d+)r/.exec(reply);
  if (!m) return null;
  const region = { top: Number(m[1]) - 1, bottom: Number(m[2]) - 1 };
  return region.top === 0 && region.bottom === rows - 1 ? null : region;
}
const regionText = (r: Region): string => `${CSI}${r.top + 1};${r.bottom + 1}r`;

/**
 * The PTY host's copy of a terminal's screen on libghostty-vt (its wasm build, bound in core/pty/ghostty/), the engine
 * ScreenMirror can be swapped for (mirror.ts) to compare them. The browser stays xterm.js; the snapshot is the same
 * kind of plain VT bytes, laid out as ScreenMirror's: START, the screen (and scrollback), then the state.
 *
 * The state is read from libghostty, not followed by hand: modes, title, kitty flags, the cursor, the pen and
 * charsets (its formatter), the cursor shape, scroll region and saved cursor (asked of a copy of the terminal, which
 * is then written ESC 8 and, on the alternate screen, 1047l to read the normal one). What the API can't say is listed
 * in terminal-rendering.md ("The libghostty engine"). Writes are parsed in the call; `done` runs in a microtask.
 */
export class GhosttyMirror implements TerminalMirror {
  private term: GhosttyTerminal | null;
  private readonly stream = new StreamStatus();
  private answers: MirrorAnswers | null = null;
  /** Replies libghostty made to the chunk being written. */
  private readonly replies: string[] = [];
  private readonly scrollback: number;

  /**
   * `scrollback`: lines above the screen a snapshot carries. libghostty drops whole pages of scrollback past its
   * limit (so it keeps fewer lines than the limit, never more): it is given twice that, and the snapshot cut to it.
   * `windowsPty`: a resize never pulls lines back from the scrollback (ConPTY's own reflow); libghostty still
   * reflows the screen, which xterm.js with windowsPty doesn't (the one option the API has).
   */
  constructor(cols: number, rows: number, scrollback: number = REPLAY_SCROLLBACK, opts: { windowsPty?: WindowsPty } = {}) {
    this.scrollback = scrollback;
    this.term = GhosttyTerminal.create(
      cols,
      rows,
      { scrollback: scrollback * 2, colorQueries: true, pullScrollbackOnResize: !opts.windowsPty },
      {
        reply: (r) => this.replies.push(r),
        progress: (p) => this.stream.osc9(`4;${p.state}${p.percent >= 0 ? `;${p.percent}` : ''}`),
        program: (s) => {
          const report = programReport(s);
          if (report) this.stream.program(report);
        },
        reset: () => this.stream.reset(),
      },
    );
  }

  answerQueries(answers: MirrorAnswers): void {
    this.answers = answers;
  }

  /** Parsed now, its queries answered (if `answers.now()` says so as it arrives) once it is; `done` in a microtask. */
  write(data: string, done?: () => void): void {
    const t = this.term;
    if (t) {
      const a = this.answers?.now() ? this.answers : null;
      this.replies.length = 0;
      t.write(data);
      const replies = this.replies.splice(0);
      if (a) {
        for (const r of replies) for (const answer of translateReplies(r, a.colors)) a.send(answer);
      }
    }
    if (done) queueMicrotask(done);
  }

  /** Applied now: every write before it is parsed already. */
  resize(cols: number, rows: number): void {
    const t = this.term;
    if (!t || (cols === t.cols && rows === t.rows)) return;
    t.resize(cols, rows);
  }

  streamSignal(): StreamSignal | null {
    return this.stream.signal();
  }

  /** The grid (tests, diagnostics); 0 × 0 once disposed. */
  size(): { cols: number; rows: number } {
    const t = this.term;
    return t ? { cols: t.cols, rows: t.rows } : { cols: 0, rows: 0 };
  }

  snapshot(opts: SnapshotOptions = {}): string {
    const t = this.term;
    if (!t) return '';
    let probe: GhosttyTerminal | null = null;
    try {
      const heard: string[] = [];
      const copy = t.clone({ reply: (r) => heard.push(r) });
      probe = copy;
      const ask = (query: string): string => {
        heard.length = 0;
        copy.write(query);
        return heard.join('');
      };
      const rows = t.rows;
      copy.write(CAN);
      const style = /^\x1bP1\$r(\d+) q/.exec(ask(ASK_CURSOR_STYLE));
      const region = parseRegion(ask(ASK_REGION), rows);
      copy.write(`${ESC}8`);
      const saved = copy.cursor();
      const scrollback = opts.scrollback !== false;
      let body: string;
      if (t.screen() === 'alternate') {
        // The normal screen as it is under the alternate one: the copy leaves it as the app would (1049l puts back the
        // cursor 1049h saved). Its scroll region isn't said: libghostty keeps one region for both screens.
        copy.write(`${CSI}?1049l`);
        body = this.body(copy, scrollback) + this.place(copy, copy.cursor(), 0);
        const flags = copy.kittyKeyboardFlags();
        if (flags) body += `${CSI}>${flags}u`;
        body += ENTER_ALT + this.body(t, false);
      } else {
        body = this.body(t, scrollback);
      }
      const cursorStyle = style ? Number(style[1]) : DEFAULT_CURSOR_STYLE;
      return START + body + this.rehydrate(t, { cursorStyle, region, saved }) + t.continuation();
    } catch {
      return '';
    } finally {
      probe?.free();
    }
  }

  /** Nothing waits: every write is parsed in its call. */
  snapshotSettled(opts: SnapshotOptions = {}): Promise<string> {
    return Promise.resolve(this.snapshot(opts));
  }

  screenText(): string {
    const t = this.term;
    if (!t) return '';
    try {
      const rows = t.rows;
      const text = t.format({ vt: false, unwrap: false, trim: true, from: { tag: 'active', x: 0, y: 0 }, to: this.end(t) });
      const lines = text.split(/\r?\n/).slice(0, rows);
      while (lines.length < rows) lines.push('');
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  /** Frees the terminal and drops its wasm instance; every call after is a no-op ('' / null where it returns). */
  dispose(): void {
    this.term?.free();
    this.term = null;
  }

  private end(t: GhosttyTerminal): GridPoint {
    return { tag: 'active', x: t.cols - 1, y: t.rows - 1 };
  }

  /** The screen, and up to `scrollback` lines above it, as VT: soft-wrapped rows joined (the client wraps them again). */
  private body(t: GhosttyTerminal, withScrollback: boolean): string {
    const above = t.scrollbackRows();
    const history = withScrollback ? Math.min(above, this.scrollback) : 0;
    const from: GridPoint = history ? { tag: 'screen', x: 0, y: above - history } : { tag: 'active', x: 0, y: 0 };
    return t.format({ vt: true, unwrap: true, trim: false, from, to: this.end(t) });
  }

  /**
   * The cursor, absolute (`top`: origin mode's region top). One waiting to wrap after the last column can't be put
   * there by a position: its row is written again from column 0, which leaves it waiting the same way.
   */
  private place(t: GhosttyTerminal, c: Cursor, top: number): string {
    const cols = t.cols;
    if (!c.pendingWrap) return cup(c.y - top, Math.min(c.x, cols - 1));
    const row = t.format({
      vt: true,
      unwrap: false,
      trim: false,
      from: { tag: 'active', x: 0, y: c.y },
      to: { tag: 'active', x: cols - 1, y: c.y },
    });
    return cup(c.y - top, 0) + row.replace(/(?:\r?\n)+$/, '');
  }

  /**
   * After the screen, in ScreenMirror's order: the saved cursor (absolute, so before origin mode), the mouse (off, then
   * on), the modes, the cursor shape, title and kitty flags, the scroll region and origin mode, the cursor — then
   * insert mode (after the cursor's row is written again) and what the formatter says after a cell (`tail`).
   */
  private rehydrate(t: GhosttyTerminal, s: { cursorStyle: number; region: Region | null; saved: Cursor }): string {
    const cols = t.cols;
    const origin = t.mode(6);
    let out = '';
    if (origin) out += `${CSI}?6l`;
    if (s.saved.x || s.saved.y) out += cup(s.saved.y, Math.min(s.saved.x, cols - 1)) + `${ESC}7`;

    // Mouse: every protocol and encoding off, then the ones libghostty has on, lowest first (it keeps one flag per
    // mode, not the order they were set in: terminal-rendering.md).
    out += `${CSI}?9;1000;1002;1003l`;
    if (t.mouseTracking()) for (const m of MOUSE_PROTOCOLS) if (t.mode(m)) out += `${CSI}?${m}h`;
    out += `${CSI}?1005;1006;1015;1016l`;
    for (const m of MOUSE_ENCODINGS) if (t.mode(m)) out += `${CSI}?${m}h`;

    // No 12: libghostty keeps the blink in the cursor shape (DECSCUSR 6 then ?12h reads back as 5), so the shape says it.
    const on: number[] = [];
    const off: number[] = [];
    for (const m of BOTH_WAYS) (t.mode(m) ? on : off).push(m);
    if (!t.mode(1007)) off.push(1007); // on by default in libghostty: only a reset can be told from the default
    if (t.mode(2031)) on.push(2031);
    out +=
      decModes(
        off.sort((a, b) => a - b),
        'l',
      ) +
      decModes(
        on.sort((a, b) => a - b),
        'h',
      );
    out += t.mode(66) ? `${ESC}=` : `${ESC}>`;

    if (s.cursorStyle !== DEFAULT_CURSOR_STYLE) out += `${CSI}${s.cursorStyle} q`;
    const title = t.title();
    if (title) out += `${ESC}]2;${title.replace(CONTROL, '')}\x07`;
    const flags = t.kittyKeyboardFlags();
    if (flags) out += `${CSI}>${flags}u`;

    if (s.region) out += regionText(s.region);
    if (origin) out += `${CSI}?6h`;
    out += this.place(t, t.cursor(), origin && s.region ? s.region.top : 0);
    out += t.mode(4, true) ? `${CSI}4h` : `${CSI}4l`;
    return out + this.tail(t);
  }

  /** What the formatter writes after a cell for TAIL (the pen, charsets…): a one-cell range with and without them. */
  private tail(t: GhosttyTerminal): string {
    const at: GridPoint = { tag: 'active', x: 0, y: 0 };
    const base = t.format({ vt: true, unwrap: false, trim: false, from: at, to: at });
    const full = t.format({ vt: true, unwrap: false, trim: false, extras: TAIL, from: at, to: at });
    return full.startsWith(base) ? full.slice(base.length) : '';
  }
}
