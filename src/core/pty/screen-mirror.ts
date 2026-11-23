import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import xtermUnicode11 from '@xterm/addon-unicode11';
import { REPLAY_SCROLLBACK } from './scrollback.js';
import type { TerminalColors } from './terminal-colors.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;
const { Unicode11Addon } = xtermUnicode11;

export type HeadlessTerminal = InstanceType<typeof Terminal>;
type Screen = 'normal' | 'alternate';
/** A CSI sequence's parameters as xterm passes them: a number, or the sub-parameters of the one before it. */
type Params = (number | number[])[];

const ESC = '\x1b';
const CSI = '\x1b[';
/** What the serialize addon writes before the alternate screen's content (0.14.0 and master alike). */
const ENTER_ALT = '\x1b[?1049h\x1b[H';
/**
 * Before the screen: the state the addon's output assumes — the normal screen (ESC 7 first, so the cursor 1049l
 * restores is where it is), cleared, with DECSTR's defaults (character sets, scroll region, origin mode, pen). A
 * fresh terminal is there already; a terminal that was written a snapshot before (or `work attach`'s real one,
 * left in the line-drawing set by something) would draw this one through what the last one left.
 */
const START = '\x1b7\x1b[?1049l\x1b[H\x1b[2J\x1b[!p\x1b[0m';
const MOUSE_PROTOCOL = { x10: 9, vt200: 1000, drag: 1002, any: 1003 } as const;
const MOUSE_ENCODINGS = new Set([1005, 1006, 1015, 1016]);
const ALT_SCREEN = new Set([47, 1047, 1049]);
/** G0..G3, by the intermediate that designates each. */
const CHARSET_SLOTS = ['(', ')', '*', '+'] as const;
/** The character sets xterm.js knows (an unknown one is plain ASCII to it, and kept as written for a native terminal). */
const CHARSET_FINALS = '0AB4C5RQKYE6ZH7=';
/** kitty keeps 8 entries per screen; a push past that drops the oldest. */
const KEYBOARD_STACK_MAX = 8;
/** C0, DEL and C1: never let a remembered title end or start a sequence when it is written back. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** What the mirror keeps per screen: xterm.js keeps these per buffer, kitty keeps its key flags per screen. */
export interface ScreenState {
  /** DECSC (ESC 7, CSI s, 1048): the column, and the line counted from the top of the scrollback. */
  savedCursor: { x: number; line: number } | null;
  /** DECSTBM, 0-based and inclusive; null = the whole screen. */
  scrollRegion: { top: number; bottom: number } | null;
  /** kitty keyboard protocol flags, bottom of the stack first. */
  keyboardFlags: number[];
}

/** The state an attaching terminal needs that the serialize addon doesn't write (terminal-rendering.md). */
export interface MirrorState {
  /** DECTCEM (25) reset. */
  cursorHidden: boolean;
  /** DECSET 12 as the app last set it; null = never. */
  cursorBlink: boolean | null;
  /** DECSCUSR 1..6; null = the terminal's default (never set, or 0). */
  cursorStyle: number | null;
  /** OSC 0 / 2; null = never set. */
  title: string | null;
  /** DECSET / DECRST of 1005, 1006, 1015, 1016 in the order the app wrote them (one entry per mode, its last). */
  mouseEncoding: { mode: number; on: boolean }[];
  /** 1007; null = never set (terminals differ on the default). */
  alternateScroll: boolean | null;
  /** 2031 (colour-scheme change reports); null = never set. */
  colorSchemeUpdates: boolean | null;
  /** XTMODKEYS modifyOtherKeys (CSI > 4 ; n m); null = the default. */
  modifyOtherKeys: number | null;
  /** G0..G3 designations (final characters; B = ASCII). */
  charsets: string[];
  normal: ScreenState;
  alternate: ScreenState;
}

const freshScreen = (): ScreenState => ({ savedCursor: null, scrollRegion: null, keyboardFlags: [] });
const freshState = (title: string | null = null): MirrorState => ({
  cursorHidden: false,
  cursorBlink: null,
  cursorStyle: null,
  title,
  mouseEncoding: [],
  alternateScroll: null,
  colorSchemeUpdates: null,
  modifyOtherKeys: null,
  charsets: ['B', 'B', 'B', 'B'],
  normal: freshScreen(),
  alternate: freshScreen(),
});

/** The main parameters (sub-parameters dropped: none of the sequences tracked here has any). */
const nums = (params: Params): number[] => params.filter((p): p is number => typeof p === 'number');
const decModes = (modes: number[], final: 'h' | 'l'): string => (modes.length ? `${CSI}?${modes.join(';')}${final}` : '');
const cup = (row: number, col: number): string => `${CSI}${row + 1};${col + 1}H`;

/** The OSC colour queries xterm.js leaves to its renderer (CoreBrowserTerminal), which a headless one never answers. */
const SPECIAL_COLORS = ['10', '11', '12'] as const;

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
 * The PTY host's copy of a terminal's screen: an @xterm/headless terminal fed everything the PTY prints, and the
 * snapshot a newly attached client is sent first (`replay`). The serialize addon draws the screen and scrollback
 * but leaves out state a full-screen agent depends on — the mouse encoding, a hidden cursor, the cursor's shape,
 * the title, the scroll region, the kitty keyboard flags — and places the cursor wrong after origin mode or a
 * full row. That state is followed here with xterm's own parser hooks (each returns false, so xterm still handles
 * the sequence; a sequence split across writes reaches them whole) and written after the addon's output, so a
 * fresh terminal written the snapshot ends in the same state. Uses Unicode 11 widths, as the browser does. In output
 * that arrived with no client attached, it answers the agent's queries too (`answerQueries`, terminal-rendering.md).
 */
export class ScreenMirror {
  readonly terminal: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();
  private st: MirrorState = freshState();
  private answers: MirrorAnswers | null = null;
  /** The chunk being parsed is one the mirror answers the queries in (set and cleared by the write queue's callbacks). */
  private answering = false;

  constructor(cols: number, rows: number, scrollback: number = REPLAY_SCROLLBACK) {
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
    // Emoji and symbols (👍 ⭐ ✅ ⏳ 🚀) are 2 columns in the browser, which uses Unicode 11 (PtyView): 1 here
    // laid every replayed line out for the wrong columns.
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.track();
    // xterm answers DA, DSR / CPR, DECRQM and DECRQSS itself, through onData, while it parses the query.
    this.terminal.onData((reply) => {
      if (this.answering) this.answers?.send(reply);
    });
    this.answerColors();
  }

  /**
   * From now on, the agent's queries in output written while `answers.now()` says so (no client attached) are
   * answered here: what xterm answers itself, and the colour queries it leaves to a renderer (OSC 10, 11, 12 and 4).
   */
  answerQueries(answers: MirrorAnswers): void {
    this.answers = answers;
  }

  /**
   * Output, queued for parsing. Whether its queries are answered here is decided now, as it arrives: xterm parses it a
   * moment later, by when a client may have attached (and been sent a screen with no query in it) or detached. A
   * write's callback runs once it is parsed and before the next write is, so empty writes around it mark the chunk.
   */
  write(data: string, done?: () => void): void {
    if (!this.answers?.now()) {
      this.terminal.write(data, done);
      return;
    }
    this.terminal.write('', () => (this.answering = true));
    this.terminal.write(data, () => {
      this.answering = false;
      done?.();
    });
  }

  resize(cols: number, rows: number): void {
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    // xterm.js sets both buffers' scroll regions back to the whole screen on a resize.
    this.st.normal.scrollRegion = null;
    this.st.alternate.scrollRegion = null;
    this.terminal.resize(cols, rows);
  }

  /** A copy of the tracked state (tests, diagnostics). */
  state(): MirrorState {
    return structuredClone(this.st);
  }

  /**
   * The screen and scrollback as escape sequences that redraw it, then the state that puts a fresh terminal in
   * the same modes (`rehydrate`). What a client attaching is sent instead of raw output — raw bytes can start
   * mid-sequence and were drawn for another client's grid. '' if it can't be taken.
   */
  snapshot(): string {
    let body: string;
    try {
      body = this.serializer.serialize();
    } catch {
      return '';
    }
    let regionBeforeAlt = false;
    if (this.terminal.buffer.active.type === 'alternate') {
      // What belongs to the normal screen goes before the addon switches to the alternate one.
      const at = body.indexOf(ENTER_ALT);
      if (at >= 0) {
        const normal = this.normalUnderAlt();
        regionBeforeAlt = normal.region;
        body = body.slice(0, at) + normal.text + body.slice(at);
      }
    }
    return START + body + this.rehydrate(regionBeforeAlt);
  }

  /** snapshot(), once everything written so far is parsed: xterm queues writes, and a write's callback runs once it is. */
  snapshotSettled(): Promise<string> {
    return new Promise((resolve) => {
      try {
        this.terminal.write('', () => resolve(this.snapshot()));
      } catch {
        resolve(this.snapshot());
      }
    });
  }

  /** The visible screen as plain text, one line per row. */
  screenText(): string {
    try {
      const buf = this.terminal.buffer.active;
      const lines: string[] = [];
      for (let y = buf.viewportY; y < buf.viewportY + this.terminal.rows; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  dispose(): void {
    this.terminal.dispose();
  }

  private get screen(): Screen {
    return this.terminal.buffer.active.type;
  }

  /** The normal screen's own state while the alternate one is shown: its scroll region (then its cursor again,
   *  which DECSTBM homes and 1049 saves) and its keyboard flags. */
  private normalUnderAlt(): { text: string; region: boolean } {
    const n = this.st.normal;
    const cur = this.terminal.buffer.normal;
    let text = '';
    if (n.scrollRegion) text += `${CSI}${n.scrollRegion.top + 1};${n.scrollRegion.bottom + 1}r`;
    // Where leaving the alternate screen puts the cursor back: the same rule as the cursor at the end (rehydrate).
    if (n.scrollRegion || cur.cursorX < this.terminal.cols) text += cup(cur.cursorY, Math.min(cur.cursorX, this.terminal.cols - 1));
    text += n.keyboardFlags.map((f) => `${CSI}>${f}u`).join('');
    return { text, region: !!n.scrollRegion };
  }

  /**
   * Everything after the addon's output, in an order that matters: the saved cursor first (it needs an absolute
   * position), the modes, then the scroll region and origin mode — both move the cursor — and the cursor last.
   * Each mode is stated whatever the addon wrote, so one it already wrote (or a later addon version writes) is
   * only said twice; modes with a universal default are stated either way, so a native terminal that `work attach`
   * writes into ends in them even if something left it otherwise. Never 2026 (synchronized output): a snapshot
   * with it on would hold the client's screen until the app happened to turn it off.
   */
  private rehydrate(regionBeforeAlt: boolean): string {
    const t = this.terminal;
    const m = t.modes;
    const s = this.st;
    const buf = t.buffer.active;
    const screen = s[this.screen];
    let out = '';
    let moved = false;

    if (m.originMode) {
      out += `${CSI}?6l`; // positions below are absolute; set again before the cursor
      moved = true;
    }
    if (screen.savedCursor) {
      out += cup(Math.max(screen.savedCursor.line - buf.baseY, 0), Math.min(screen.savedCursor.x, t.cols - 1)) + `${ESC}7`;
      moved = true;
    }

    // Mouse: off, then on as the app has it — xterm.js turns any protocol off with any reset, and an encoding
    // with 1006l / 1016l alike, so resets must come first. The encodings are replayed in the app's order: a
    // terminal that supports only some of them ends where it would have.
    out += `${CSI}?9;1000;1002;1003l`;
    if (m.mouseTrackingMode !== 'none') out += `${CSI}?${MOUSE_PROTOCOL[m.mouseTrackingMode]}h`;
    out += `${CSI}?1005;1006;1015;1016l`;
    for (const e of s.mouseEncoding) out += `${CSI}?${e.mode}${e.on ? 'h' : 'l'}`;

    const on: number[] = [];
    const off: number[] = [];
    const state = (mode: number, value: boolean | null) => {
      if (value !== null) (value ? on : off).push(mode);
    };
    state(1, m.applicationCursorKeysMode);
    state(7, m.wraparoundMode);
    state(12, s.cursorBlink);
    state(25, !s.cursorHidden);
    state(45, m.reverseWraparoundMode);
    state(1004, m.sendFocusMode);
    state(1007, s.alternateScroll);
    state(2004, m.bracketedPasteMode);
    state(2031, s.colorSchemeUpdates);
    out += decModes(off, 'l') + decModes(on, 'h');
    out += m.applicationKeypadMode ? `${ESC}=` : `${ESC}>`;
    out += m.insertMode ? `${CSI}4h` : `${CSI}4l`;

    if (s.cursorStyle !== null) out += `${CSI}${s.cursorStyle} q`;
    if (s.title !== null) out += `${ESC}]2;${s.title.replace(CONTROL, '')}\x07`;
    out += screen.keyboardFlags.map((f) => `${CSI}>${f}u`).join('');
    if (s.modifyOtherKeys !== null) out += `${CSI}>4;${s.modifyOtherKeys}m`;
    s.charsets.forEach((f, i) => {
      if (f !== 'B') out += `${ESC}${CHARSET_SLOTS[i]}${f}`;
    });

    const region = screen.scrollRegion;
    // A region stated for the normal screen first would carry into this one on a terminal that keeps one region.
    if (region || regionBeforeAlt) {
      out += region ? `${CSI}${region.top + 1};${region.bottom + 1}r` : `${CSI}r`;
      moved = true;
    }
    if (m.originMode) out += `${CSI}?6h`;
    // The cursor last, absolute: the addon's relative moves land one column short from a full row (xterm.js
    // #6165), and origin mode / DECSTBM home it. Except a cursor waiting to wrap after the last column, which
    // no position can say: there the addon's output already leaves it, unless something above moved it.
    const pendingWrap = buf.cursorX >= t.cols;
    if (moved || !pendingWrap) {
      const top = m.originMode && region ? region.top : 0;
      out += cup(buf.cursorY - top, Math.min(buf.cursorX, t.cols - 1));
    }
    return out;
  }

  private track(): void {
    const t = this.terminal;
    const p = t.parser;
    t.onTitleChange((title) => (this.st.title = title));
    p.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => this.decset(nums(params), true));
    p.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => this.decset(nums(params), false));
    p.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const n = nums(params)[0] ?? 0;
      if (n >= 0 && n <= 6) this.st.cursorStyle = n === 0 ? null : n;
      return false;
    });
    p.registerCsiHandler({ final: 'r' }, (params) => {
      // xterm.js's setScrollRegion: a bottom past the screen (or 0) is the last row; a region of one row is ignored.
      const [first = 0, second = 0] = nums(params);
      const top = first || 1;
      const bottom = params.length < 2 || second > t.rows || second === 0 ? t.rows : second;
      if (bottom > top) this.st[this.screen].scrollRegion = top === 1 && bottom === t.rows ? null : { top: top - 1, bottom: bottom - 1 };
      return false;
    });
    p.registerEscHandler({ final: '7' }, () => this.saveCursor(this.screen));
    p.registerCsiHandler({ final: 's' }, () => this.saveCursor(this.screen));
    // DECSTR: what xterm.js's soft reset puts back that is followed here.
    p.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      const screen = this.st[this.screen];
      screen.savedCursor = null;
      screen.scrollRegion = null;
      this.st.cursorHidden = false;
      this.st.cursorStyle = null;
      this.st.charsets = ['B', 'B', 'B', 'B'];
      return false;
    });
    // RIS: everything, but what xterm.js 6 keeps through it: the title, DECSET 12 (an option to it) and a hidden cursor.
    p.registerEscHandler({ final: 'c' }, () => {
      this.st = { ...freshState(this.st.title), cursorBlink: this.st.cursorBlink, cursorHidden: this.st.cursorHidden };
      return false;
    });
    for (const [i, slot] of CHARSET_SLOTS.entries())
      for (const final of CHARSET_FINALS)
        p.registerEscHandler({ intermediates: slot, final }, () => {
          this.st.charsets[i] = final;
          return false;
        });
    // kitty keyboard protocol: push, pop, set (CSI > f u, CSI < n u, CSI = f ; mode u), per screen.
    p.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      const stack = this.st[this.screen].keyboardFlags;
      stack.push(nums(params)[0] ?? 0);
      if (stack.length > KEYBOARD_STACK_MAX) stack.shift();
      return false;
    });
    p.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      const stack = this.st[this.screen].keyboardFlags;
      stack.splice(Math.max(stack.length - (nums(params)[0] || 1), 0));
      return false;
    });
    p.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      const stack = this.st[this.screen].keyboardFlags;
      const [flags = 0, mode = 1] = nums(params);
      const current = stack.at(-1) ?? 0;
      const next = mode === 2 ? current | flags : mode === 3 ? current & ~flags : flags;
      if (stack.length) stack[stack.length - 1] = next;
      else if (next) stack.push(next); // flags 0 on an empty stack is where it already is
      return false;
    });
    // XTMODKEYS: CSI > 4 ; n m sets modifyOtherKeys, CSI > 4 m and CSI > 4 n put it back.
    p.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
      const [resource = 0, value] = nums(params);
      if (resource === 4 || params.length <= 1) this.st.modifyOtherKeys = resource === 4 && value ? value : null;
      return false;
    });
    p.registerCsiHandler({ prefix: '>', final: 'n' }, (params) => {
      const resource = nums(params)[0] ?? 0;
      if (resource === 4 || resource === 0) this.st.modifyOtherKeys = null;
      return false;
    });
  }

  /**
   * OSC 10 / 11 / 12 / 4 with `?`: xterm.js leaves the answer to its renderer, so a headless one stays silent. Answered
   * as the browser's xterm.js does (`_setOrReportSpecialColor`, `setOrReportIndexedColor`): OSC 10 ; ? ; ? asks for 10
   * and 11, OSC 4 takes index ; ? pairs. Each handler returns false: xterm still handles a colour being set.
   */
  private answerColors(): void {
    const p = this.terminal.parser;
    SPECIAL_COLORS.forEach((first, offset) =>
      p.registerOscHandler(Number(first), (data) => {
        const a = this.answering ? this.answers : null;
        data.split(';').forEach((spec, i) => {
          const slot = SPECIAL_COLORS[offset + i];
          if (a && slot && spec === '?') a.send(a.colors.reply(slot));
        });
        return false;
      }),
    );
    p.registerOscHandler(4, (data) => {
      const a = this.answering ? this.answers : null;
      const slots = data.split(';');
      for (let i = 0; a && i + 1 < slots.length; i += 2) {
        const index = /^\d+$/.test(slots[i]) ? Number(slots[i]) : -1;
        if (index >= 0 && index <= 255 && slots[i + 1] === '?') a.send(a.colors.reply(`4;${index}`));
      }
      return false;
    });
  }

  private saveCursor(screen: Screen): boolean {
    const buf = this.terminal.buffer.active;
    this.st[screen].savedCursor = { x: buf.cursorX, line: buf.baseY + buf.cursorY };
    return false;
  }

  private decset(modes: number[], on: boolean): boolean {
    const s = this.st;
    // A sequence may switch screens part-way (CSI ? 1049 ; 1000 h): follow it.
    let screen = this.screen;
    for (const mode of modes) {
      if (mode === 12) s.cursorBlink = on;
      else if (mode === 25) s.cursorHidden = !on;
      else if (mode === 1007) s.alternateScroll = on;
      else if (mode === 2031) s.colorSchemeUpdates = on;
      else if (MOUSE_ENCODINGS.has(mode)) {
        s.mouseEncoding = [...s.mouseEncoding.filter((e) => e.mode !== mode), { mode, on }];
        // Only resets left: every terminal is back at its default encoding.
        if (s.mouseEncoding.every((e) => !e.on)) s.mouseEncoding = [];
      } else if (mode === 1048 && on) this.saveCursor(screen);
      else if (ALT_SCREEN.has(mode)) {
        // 1049 saves the normal screen's cursor on the way in (the snapshot's own 1049h does that again) and puts
        // it back on the way out: what ESC 7 saved before is gone, and the one restored is where the cursor is.
        if (on) screen = 'alternate';
        else if (screen === 'alternate') {
          // Leaving it clears the alternate buffer (its region with it); its saved cursor stays, as in xterm.js.
          s.alternate.scrollRegion = null;
          s.alternate.keyboardFlags = [];
          if (mode === 1049) s.normal.savedCursor = null;
          screen = 'normal';
        }
      }
    }
    return false;
  }
}
