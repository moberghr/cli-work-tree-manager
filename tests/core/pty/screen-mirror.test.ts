import { describe, it, expect, afterEach, vi } from 'vitest';
import xtermHeadless from '@xterm/headless';
import xtermUnicode11 from '@xterm/addon-unicode11';
import { ScreenMirror, type HeadlessTerminal, type MirrorState } from '../../../src/core/pty/screen-mirror.js';

// What was logged as swallowed (the real logger runs too).
const swallowed = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/core/platform/best-effort.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/platform/best-effort.js')>();
  return {
    ...real,
    logSwallowed: (label: string, err: unknown) => {
      swallowed.push(label);
      real.logSwallowed(label, err);
    },
  };
});
import { REPLAY_SCROLLBACK, VIEW_SCROLLBACK } from '../../../src/core/pty/scrollback.js';
import { TerminalColors } from '../../../src/core/pty/terminal-colors.js';

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = xtermUnicode11;

const ESC = '\x1b';
const CSI = '\x1b[';

const open: { dispose(): void }[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.dispose();
});

/** A terminal set up as the browser's is (PtyView): xterm.js with Unicode 11 widths and VIEW_SCROLLBACK. */
function browserLike(cols: number, rows: number): HeadlessTerminal {
  const t = new Terminal({ cols, rows, scrollback: VIEW_SCROLLBACK, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  open.push(t);
  return t;
}

function mirror(cols: number, rows: number, scrollback?: number): ScreenMirror {
  const m = new ScreenMirror(cols, rows, scrollback);
  open.push(m);
  return m;
}

const write = (t: { write(d: string, cb?: () => void): void }, data: string) => new Promise<void>((r) => t.write(data, r));

/** The terminal's own answer to a query (DECRQM, DECRQSS): what it holds, not what we think it holds. */
async function ask(t: HeadlessTerminal, query: string): Promise<string> {
  let reply = '';
  const sub = t.onData((d) => (reply += d));
  await write(t, query);
  sub.dispose();
  return reply;
}
const DECRQM = [1, 6, 7, 9, 12, 25, 45, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1049, 2004];
async function modeReplies(t: HeadlessTerminal): Promise<string[]> {
  const out: string[] = [];
  for (const m of DECRQM) out.push(await ask(t, `${CSI}?${m}$p`));
  return out;
}
const regionReply = (t: HeadlessTerminal) => ask(t, `${ESC}P$qr${ESC}\\`);

function lines(t: HeadlessTerminal, which: 'active' | 'normal' = 'active'): string[] {
  const b = which === 'active' ? t.buffer.active : t.buffer.normal;
  return Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? '');
}
/** The rows on screen. */
const screen = (t: HeadlessTerminal) => lines(t).slice(-t.rows);
const cursor = (t: HeadlessTerminal) => [t.buffer.active.cursorX, t.buffer.active.cursorY];
/** terminal.modes but 2026, which a snapshot never carries. */
function modes(t: HeadlessTerminal) {
  const { synchronizedOutputMode: _sync, ...rest } = t.modes;
  return rest;
}
/** Tracked state as a snapshot carries it: an inactive screen's saved cursor isn't replayed (1049 saves its own). */
function carried(s: MirrorState, active: 'normal' | 'alternate'): MirrorState {
  const other = active === 'normal' ? 'alternate' : 'normal';
  return { ...s, [other]: { ...s[other], savedCursor: null } };
}

/**
 * Write `input` to a mirror, its snapshot to a fresh browser-like terminal and to a second mirror (which tracks
 * what the terminal doesn't expose: title, cursor shape, kitty flags, modifyOtherKeys, the mouse encodings
 * xterm.js ignores).
 */
async function roundTrip(input: string | string[], cols = 30, rows = 8) {
  const source = mirror(cols, rows);
  for (const chunk of [input].flat()) await write(source, chunk);
  const snap = source.snapshot()!;
  const target = browserLike(cols, rows);
  let title: string | undefined;
  target.onTitleChange((x) => (title = x));
  await write(target, snap);
  const copy = mirror(cols, rows);
  await write(copy, snap);
  return { source, target, copy, snap, title: () => title };
}

/** Same text in every row (both screens), same cursor, same modes — as xterm reports them — and same tracked state. */
async function expectSame({ source, target, copy, snap }: Awaited<ReturnType<typeof roundTrip>>) {
  const src = source.terminal;
  expect(target.buffer.active.type).toBe(src.buffer.active.type);
  expect(lines(target)).toEqual(lines(src));
  expect(lines(target, 'normal')).toEqual(lines(src, 'normal'));
  expect(cursor(target)).toEqual(cursor(src));
  expect(modes(target)).toEqual(modes(src));
  expect(await modeReplies(target)).toEqual(await modeReplies(src));
  expect(await regionReply(target)).toEqual(await regionReply(src));
  const active = src.buffer.active.type;
  expect(carried(copy.state(), active)).toEqual(carried(source.state(), active));
  expect(snap).not.toContain('2026');
}

describe('ScreenMirror snapshot round trip', () => {
  const cases: [string, string][] = [
    ['SGR mouse encoding with drag tracking (1006, 1002)', `${CSI}?1002h${CSI}?1006h`],
    ['SGR-pixel mouse encoding with any-motion tracking (1016, 1003)', `${CSI}?1003h${CSI}?1016h`],
    ['X10 mouse (9)', `${CSI}?9h`],
    ['encodings xterm.js ignores after SGR (1006, then 1015 and 1005)', `${CSI}?1000h${CSI}?1006h${CSI}?1015h${CSI}?1005h`],
    ['mouse on and off again', `${CSI}?1000;1006h${CSI}?1000;1006l`],
    ['an encoding reset after another was set (1016 then 1016l)', `${CSI}?1006h${CSI}?1016h${CSI}?1016l`],
    ['hidden cursor (25)', `${CSI}?25l`],
    ['cursor shape and blink (DECSCUSR, 12)', `${CSI}5 q${CSI}?12h`],
    ['steady underline cursor', `${CSI}4 q`],
    ['bracketed paste, focus, alternate scroll, colour-scheme reports', `${CSI}?2004h${CSI}?1004h${CSI}?1007h${CSI}?2031h`],
    ['cursor keys and keypad (DECCKM, DECKPAM)', `${CSI}?1h${ESC}=`],
    ['insert mode, no wraparound, reverse wraparound', `${CSI}4h${CSI}?7l${CSI}?45h`],
    ['kitty keyboard flags: pushes, a pop and a set', `${CSI}>1u${CSI}>3u${CSI}>5u${CSI}<u${CSI}=9;2u`],
    ['kitty flags set on an empty stack', `${CSI}=5;1u`],
    ['modifyOtherKeys', `${CSI}>4;2m`],
    ['line drawing in G0, G1 designated', `${ESC}(0${ESC})A`],
    ['saved cursor (ESC 7)', `${CSI}3;4H${ESC}7${CSI}1;1Hx`],
    ['saved cursor (CSI s)', `${CSI}5;9H${CSI}s${CSI}2;2H`],
    ['scroll region', `${CSI}2;6r${CSI}4;3Hab`],
    ['origin mode inside a scroll region (xterm.js #6233)', `${CSI}2;6r${CSI}?6h${CSI}2;3Hab`],
    ['a full row then backspace (xterm.js #6165)', `${'x'.repeat(30)}\b`],
    ['a full row then the cursor up', `\r\n${'x'.repeat(30)}${CSI}A`],
    ['a full row, waiting to wrap', 'x'.repeat(30)],
    ['a full bottom row, waiting to wrap', `${'\r\n'.repeat(7)}${'y'.repeat(30)}`],
    ['window title (OSC 0)', `${ESC}]0;agent · task${ESC}\\`],
  ];
  for (const [name, input] of cases) {
    it(name, async () => {
      await expectSame(await roundTrip(`some output\r\n${input}`));
    });
  }

  it('the title reaches a fresh terminal (OSC 2)', async () => {
    const r = await roundTrip(`${ESC}]2;✳ fixing the build\x07`);
    expect(r.title()).toBe('✳ fixing the build');
    await expectSame(r);
  });

  it('a waiting wrap still wraps: the next character goes on the next row', async () => {
    for (const input of ['x'.repeat(30), `${'\r\n'.repeat(7)}${'y'.repeat(30)}`]) {
      const r = await roundTrip(input);
      await write(r.source, 'Z');
      await write(r.target, 'Z');
      expect(lines(r.target)).toEqual(lines(r.source.terminal));
      expect(cursor(r.target)).toEqual(cursor(r.source.terminal));
    }
  });

  it('what comes after a snapshot draws the same: line drawing, the saved cursor, a full row', async () => {
    for (const [input, after] of [
      [`${ESC}(0`, 'qqq'],
      [`${CSI}3;4H${ESC}7${CSI}1;1H`, `${ESC}8!`],
      [`${'x'.repeat(30)}\b`, 'Y'],
      [`${CSI}2;6r${CSI}?6h${CSI}2;3H`, 'ab\r\n\r\n\r\n\r\n\r\ncd'],
    ]) {
      const r = await roundTrip(input);
      await write(r.source, after);
      await write(r.target, after);
      expect(lines(r.target)).toEqual(lines(r.source.terminal));
      expect(cursor(r.target)).toEqual(cursor(r.source.terminal));
    }
  });

  it('a full-screen agent: alternate screen, mouse, paste, focus, hidden cursor, shape, title, flags, region', async () => {
    const normal = `${CSI}31mbuild ok${CSI}0m\r\n$ agent\r\n${CSI}>1u${CSI}1;6r${CSI}4;2H${ESC}7`;
    const enter = `${CSI}?1049h${CSI}?1000h${CSI}?1002h${CSI}?1006h${CSI}?2004h${CSI}?1004h${CSI}?25l${CSI}5 q${ESC}]2;agent${ESC}\\${CSI}>3u${CSI}2;7r`;
    const frame = Array.from({ length: 8 }, (_, i) => `${CSI}${i + 1};1H${CSI}3${i % 8}m row ${i} ${CSI}0m│ 👍 ✅`).join('');
    const r = await roundTrip([normal, enter, frame, `${CSI}?2026h${CSI}4;6H`]);
    expect(r.source.terminal.buffer.active.type).toBe('alternate');
    await expectSame(r);
    expect(r.title()).toBe('agent');
    expect(r.copy.state().normal.keyboardFlags).toEqual([1]);
    expect(r.copy.state().alternate.keyboardFlags).toEqual([3]);
    // Leaving the alternate screen afterwards lands both where the app left the normal one.
    await write(r.source, `${CSI}?1049l`);
    await write(r.target, `${CSI}?1049l`);
    expect(lines(r.target)).toEqual(lines(r.source.terminal));
    expect(cursor(r.target)).toEqual(cursor(r.source.terminal));
    expect(await regionReply(r.target)).toEqual(await regionReply(r.source.terminal));
  });

  it('the normal screen with scrollback: every line comes back, coloured lines and all', async () => {
    const out = Array.from(
      { length: 300 },
      (_, i) => `${CSI}38;5;${i % 256}mline ${i}${CSI}0m ${i % 3 ? '' : `${CSI}1;44mbold${CSI}0m`}`,
    ).join('\r\n');
    const r = await roundTrip(`${out}\r\n$ git sta`);
    expect(lines(r.target)).toHaveLength(301);
    await expectSame(r);
  });

  it('keeps REPLAY_SCROLLBACK lines above the screen', async () => {
    const m = mirror(30, 8);
    await write(m, Array.from({ length: REPLAY_SCROLLBACK + 100 }, (_, i) => `l${i}`).join('\r\n'));
    expect(m.terminal.buffer.active.length).toBe(REPLAY_SCROLLBACK + 8);
  });

  it('measures emoji, CJK, ZWJ and VS16 text as the browser does (Unicode 11)', async () => {
    const m = mirror(40, 4);
    await write(m, '👍⭐✅⏳🚀|');
    expect(m.terminal.buffer.active.cursorX).toBe(11); // 1 each with Unicode 6 widths: 6
    const r = await roundTrip(`👍⭐✅⏳🚀|\r\na一二b|\r\n👨‍👩‍👧|\r\n❤️ ☀️|`, 40, 6);
    await expectSame(r);
  });

  it('never puts synchronized output (2026) in a snapshot', async () => {
    const r = await roundTrip(`${CSI}?2026hhalf a frame`);
    expect(r.source.terminal.modes.synchronizedOutputMode).toBe(true);
    expect(r.snap).not.toContain('2026');
    expect(r.target.modes.synchronizedOutputMode).toBe(false);
    await expectSame(r);
  });

  it('RIS forgets what was tracked (but the title and a hidden cursor, as xterm.js does)', async () => {
    const set = `${CSI}?1006h${CSI}?25l${CSI}5 q${CSI}>1u${CSI}>4;2m${CSI}?1007h${CSI}2;5r${ESC}(0${ESC}7${ESC}]2;t${ESC}\\`;
    const r = await roundTrip(`${set}${ESC}c`);
    const s = r.source.state();
    expect(s).toMatchObject({ cursorHidden: true, cursorStyle: null, mouseEncoding: [], modifyOtherKeys: null, alternateScroll: null });
    expect(s.charsets).toEqual(['B', 'B', 'B', 'B']);
    expect(s.normal).toEqual({ savedCursor: null, scrollRegion: null, keyboardFlags: [] });
    expect(s.title).toBe('t');
    for (const gone of ['?1006h', '5 q', '>1u', '>4;2m', '1007', `${ESC}(0`]) expect(r.snap).not.toContain(gone);
    await expectSame(r);
  });

  it('DECSTR puts back the cursor, region, saved cursor and character sets, and keeps the mouse', async () => {
    const r = await roundTrip(`${CSI}?1002;1006h${CSI}?25l${CSI}2;5r${CSI}4 q${ESC}(0${CSI}3;3H${ESC}7${CSI}!p`);
    expect(r.source.state()).toMatchObject({ cursorHidden: false, cursorStyle: null, charsets: ['B', 'B', 'B', 'B'] });
    expect(r.source.state().normal).toMatchObject({ savedCursor: null, scrollRegion: null });
    expect(r.source.terminal.modes.mouseTrackingMode).toBe('drag');
    await expectSame(r);
  });

  it('a snapshot written twice ends in the same state as once (the first screen goes to the scrollback)', async () => {
    const input = [
      `${CSI}31mred${CSI}0m\r\n${CSI}>1u`,
      `${CSI}?1049h${CSI}?1002;1006h${CSI}?25l${CSI}6 q${CSI}2;6r${CSI}?6h${CSI}3;4Hab${ESC}(0`,
    ];
    const once = await roundTrip(input);
    const twice = browserLike(30, 8);
    await write(twice, once.snap + once.snap);
    expect(screen(twice)).toEqual(screen(once.target));
    expect(lines(twice, 'normal').slice(-8)).toEqual(lines(once.target, 'normal').slice(-8));
    expect(cursor(twice)).toEqual(cursor(once.target));
    expect(modes(twice)).toEqual(modes(once.target));
    expect(await modeReplies(twice)).toEqual(await modeReplies(once.target));
    // And a snapshot of a terminal written the snapshot is the same snapshot.
    expect(once.copy.snapshot()).toBe(once.snap);
  });

  it('a sequence split across writes is tracked whole', async () => {
    const whole = `${CSI}?1006h${CSI}?25l${CSI}5 q${CSI}>4;2m${ESC}]2;split${ESC}\\${CSI}>7u`;
    const r = await roundTrip(whole.split(''));
    expect(r.source.state()).toMatchObject({ cursorHidden: true, cursorStyle: 5, modifyOtherKeys: 2, title: 'split' });
    expect(r.source.state().normal.keyboardFlags).toEqual([7]);
    await expectSame(r);
  });

  it('a resize puts the scroll regions back, as xterm.js does', async () => {
    const m = mirror(30, 8);
    await write(m, `${CSI}2;5r`);
    expect(m.state().normal.scrollRegion).toEqual({ top: 1, bottom: 4 });
    m.resize(30, 10);
    expect(m.state().normal.scrollRegion).toBeNull();
    expect(await regionReply(m.terminal)).toBe(`${ESC}P1$r1;10r${ESC}\\`);
  });

  it('leaving the alternate screen forgets its region and keyboard flags', async () => {
    const r = await roundTrip(`${CSI}?1049h${CSI}2;5r${CSI}>3u${CSI}?1049l`);
    expect(r.source.state().alternate).toMatchObject({ scrollRegion: null, keyboardFlags: [] });
    await expectSame(r);
  });
});

describe('ScreenMirror resize, in order with the output (terminal-rendering.md, "Resizing and attaching at a size")', () => {
  /** An agent's frame for a 40-column grid: a full row, then the cursor put on the next row by position. */
  const frameFor40 = `${'x'.repeat(40)}${CSI}2;1Hnext`;

  it('output not parsed yet when the grid changes is drawn for the grid it was written for, then reflowed', async () => {
    const m = mirror(40, 5);
    m.write(frameFor40); // queued: xterm parses it later
    m.resize(20, 5); // at once: before that parse
    const shot = await m.snapshotSettled();
    // Drawn at 40 and reflowed: nothing overwritten. (Resized first, the row would wrap at 20 and "next" overwrite it.)
    expect(m.screenText().split('\n').slice(0, 3)).toEqual(['x'.repeat(20), 'x'.repeat(20), 'next']);
    expect([m.terminal.cols, m.terminal.rows]).toEqual([20, 5]);
    expect(shot).toContain('next');
  });

  it('with nothing queued it applies at once; the same grid again changes nothing', async () => {
    const m = mirror(40, 5);
    await write(m, 'settled');
    m.resize(30, 6);
    expect([m.terminal.cols, m.terminal.rows]).toEqual([30, 6]);
    m.write('queued');
    m.resize(30, 6);
    expect([m.terminal.cols, m.terminal.rows]).toEqual([30, 6]);
  });

  it('two resizes behind output apply in order; a snapshot asked for after them is at the last', async () => {
    const m = mirror(40, 5);
    m.write(frameFor40);
    m.resize(20, 5);
    m.resize(50, 7);
    await m.snapshotSettled();
    expect([m.terminal.cols, m.terminal.rows]).toEqual([50, 7]);
  });

  it('a snapshot that cannot be taken is null, never an empty screen, and is logged', async () => {
    const m = new ScreenMirror(40, 5);
    await new Promise<void>((r) => m.terminal.write('on screen', r));
    const serializer = (m as unknown as { serializer: { serialize: () => string } }).serializer;
    vi.spyOn(serializer, 'serialize').mockImplementation(() => {
      throw new Error('serializer broke');
    });
    swallowed.length = 0;
    expect(m.snapshot()).toBeNull();
    expect(await m.snapshotSettled()).toBeNull();
    expect(swallowed).toEqual(['screen copy: take a snapshot', 'screen copy: take a snapshot']);
    m.dispose();
  });

  it('disposed while a snapshot waits for its parse: the snapshot is empty, never left hanging', async () => {
    const m = new ScreenMirror(40, 5);
    m.write('x'.repeat(100_000));
    const shot = m.snapshotSettled();
    m.dispose();
    expect(await shot).toBe('');
    expect(await m.snapshotSettled()).toBe('');
  });
});

describe('a screen-only snapshot (scrollback: false): the catch-up screen work attach is sent', () => {
  const history = Array.from({ length: 300 }, (_, i) => `${CSI}38;5;${i % 256}mline ${i}${CSI}0m`).join('\r\n');
  /**
   * Its screen-only snapshot written to a fresh terminal, and over a terminal with your shell's history in it and a
   * stale screen on the alternate one (as `work attach` writes it: the screen cleared first, never the scrollback).
   */
  async function screenOnly(input: string | string[], cols = 30, rows = 8) {
    const source = mirror(cols, rows);
    for (const chunk of [input].flat()) await write(source, chunk);
    const snap = source.snapshot({ scrollback: false })!;
    const fresh = browserLike(cols, rows);
    await write(fresh, snap);
    const used = browserLike(cols, rows);
    await write(used, Array.from({ length: 20 }, (_, i) => `shell ${i}`).join('\r\n') + `\r\n${CSI}?1049h${CSI}?1000h${CSI}5;5Hstale`);
    await write(used, `${CSI}2J${CSI}H` + snap);
    const copy = mirror(cols, rows);
    await write(copy, snap);
    return { source, fresh, used, copy, snap };
  }
  /** The same screen (both screens' rows), cursor, modes and region as the source, in both terminals. */
  async function expectSameScreen(r: Awaited<ReturnType<typeof screenOnly>>) {
    const src = r.source.terminal;
    for (const t of [r.fresh, r.used]) {
      expect(t.buffer.active.type).toBe(src.buffer.active.type);
      expect(screen(t)).toEqual(screen(src));
      expect(lines(t, 'normal').slice(-t.rows)).toEqual(lines(src, 'normal').slice(-src.rows));
      expect(cursor(t)).toEqual(cursor(src));
      expect(modes(t)).toEqual(modes(src));
      expect(await modeReplies(t)).toEqual(await modeReplies(src));
      expect(await regionReply(t)).toEqual(await regionReply(src));
    }
    // The mirror keeps the saved cursor as a line of its buffer; on the screen, it is the same line.
    const onScreen = (m: ScreenMirror) => {
      const active = m.terminal.buffer.active;
      const s = carried(m.state(), active.type);
      const saved = s[active.type].savedCursor;
      return { ...s, [active.type]: { ...s[active.type], savedCursor: saved && { ...saved, line: saved.line - active.baseY } } };
    };
    expect(onScreen(r.copy)).toEqual(onScreen(r.source));
    // Nothing from above the screen, and your history kept.
    expect(r.snap).not.toContain('line 100');
    expect(lines(r.used, 'normal')).toContain('shell 0');
    expect(r.snap).not.toContain('\x1b[3J');
  }

  it('carries the screen and none of the scrollback; the full snapshot has it', async () => {
    const r = await screenOnly(`${history}\r\n$ git sta`);
    expect(r.source.snapshot()).toContain('line 100');
    expect(r.snap).toContain('line 299');
    await expectSameScreen(r);
  });

  it('the saved cursor, the scroll region and origin mode land where they were on the screen (counted from its top, not the scrollback’s)', async () => {
    for (const [input, after] of [
      [`${history}\r\n${CSI}3;4H${ESC}7${CSI}8;1H$ prompt`, `${ESC}8X`],
      [`${history}\r\n${CSI}5;9H${CSI}s${CSI}2;2H`, `${CSI}uY`],
      [`${history}\r\n${CSI}2;6r${CSI}?6h${CSI}2;3Hab`, 'cd\r\n\r\n\r\n\r\n\r\nef'],
    ]) {
      const r = await screenOnly(input);
      await expectSameScreen(r);
      for (const t of [r.source, r.fresh, r.used]) await write(t, after);
      for (const t of [r.fresh, r.used]) {
        expect(screen(t)).toEqual(screen(r.source.terminal));
        expect(cursor(t)).toEqual(cursor(r.source.terminal));
      }
    }
  });

  it('a full-screen agent over a normal screen with history: both screens, and leaving the alternate one lands the same', async () => {
    const normal = `${history}\r\n$ agent\r\n${CSI}>1u${CSI}1;6r${CSI}4;2H${ESC}7`;
    const enter = `${CSI}?1049h${CSI}?1002;1006h${CSI}?2004h${CSI}?25l${CSI}5 q${CSI}>3u${CSI}2;7r`;
    const frame = Array.from({ length: 8 }, (_, i) => `${CSI}${i + 1};1H${CSI}3${i % 8}m row ${i} ${CSI}0m│ 👍 ✅`).join('');
    const r = await screenOnly([normal, enter, frame, `${CSI}4;6H`]);
    expect(r.source.terminal.buffer.active.type).toBe('alternate');
    await expectSameScreen(r);
    for (const t of [r.source, r.fresh, r.used]) await write(t, `${CSI}?1049l`);
    for (const t of [r.fresh, r.used]) {
      expect(screen(t)).toEqual(screen(r.source.terminal));
      expect(cursor(t)).toEqual(cursor(r.source.terminal));
      expect(await regionReply(t)).toEqual(await regionReply(r.source.terminal));
    }
  });

  it('settled, as the catch-up takes it', async () => {
    const m = mirror(30, 8);
    m.write(`${history}\r\nlast`);
    const snap = await m.snapshotSettled({ scrollback: false });
    expect(snap).toContain('last');
    expect(snap).not.toContain('line 100');
  });
});

describe('ScreenMirror answering queries', () => {
  function answering(now: () => boolean) {
    const m = mirror(80, 24);
    const sent: string[] = [];
    m.answerQueries({ now, send: (r) => sent.push(r), colors: new TerminalColors() });
    return { m, sent };
  }

  it('answers nothing unless told to (no answers given, or output written while a client is attached)', async () => {
    const quiet = mirror(80, 24);
    const heard: string[] = [];
    quiet.terminal.onData((d) => heard.push(d));
    await write(quiet, `${CSI}c`); // xterm answers through onData, but nobody sends it on
    const { m, sent } = answering(() => false);
    await write(m, `${CSI}c${CSI}6n${ESC}]11;?${ESC}\\`);
    expect(sent).toEqual([]);
    expect(heard).toEqual([`${CSI}?1;2c`]);
  });

  it('decides as the output arrives, not when xterm parses it', async () => {
    let nobody = true;
    const { m, sent } = answering(() => nobody);
    m.write(`${CSI}5n`); // arrived with nobody attached…
    nobody = false; // …parsed after someone attached: still answered here
    m.write(`${CSI}c`); // arrived with a client attached: its to answer
    nobody = true;
    await write(m, `${ESC}]12;?\x07`);
    expect(sent).toEqual([`${CSI}0n`, `${ESC}]12;rgb:ffff/ffff/ffff${ESC}\\`]);
  });

  it('answers OSC 10;?;? as two queries and OSC 4 index;? pairs, ignoring a colour being set', async () => {
    const { m, sent } = answering(() => true);
    await write(m, `${ESC}]10;?;?${ESC}\\${ESC}]4;0;?;300;?;15;#fff;16;?${ESC}\\${ESC}]10;#123456${ESC}\\`);
    expect(sent).toEqual([
      `${ESC}]10;rgb:d4d4/d4d4/d4d4${ESC}\\`,
      `${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`,
      `${ESC}]4;0;rgb:2e2e/3434/3636${ESC}\\`,
      `${ESC}]4;16;rgb:0000/0000/0000${ESC}\\`,
    ]);
  });
});

describe('ScreenMirror on ConPTY (windowsPty)', () => {
  it('a host on Windows sets windowsPty, so the copy leaves the reflow to ConPTY as the Terminal tab does', () => {
    const m = new ScreenMirror(80, 24, undefined, { windowsPty: { backend: 'conpty', buildNumber: 19045 } });
    try {
      expect(m.terminal.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 19045 });
    } finally {
      m.dispose();
    }
  });

  it('anywhere else it sets none', () => {
    const m = new ScreenMirror(80, 24);
    try {
      expect(m.terminal.options.windowsPty?.backend).toBeUndefined();
    } finally {
      m.dispose();
    }
  });
});

describe('ScreenMirror in-band status (stream-status.ts): what the parser hands it', () => {
  const BEL = '\x07';
  const ST = `${ESC}\\`;

  it('OSC 7501 and OSC 9;4 with either terminator, split anywhere across writes', async () => {
    const m = mirror(80, 24);
    const report = `${ESC}]7501;state=blocked:app=codex:kind=permission${ST}`;
    for (const piece of [report.slice(0, 3), report.slice(3, 20), report.slice(20, -1), report.slice(-1)]) await write(m, piece);
    expect(m.streamSignal()?.program).toMatchObject({ state: 'blocked', kind: 'permission', app: 'codex' });

    const other = mirror(80, 24);
    await write(other, `text ${ESC}]9;4;1;`);
    await write(other, `55${BEL} more text`);
    expect(other.streamSignal()?.progress).toMatchObject({ state: 1, percent: 55 });
    await write(other, `${ESC}]9;4;0;${ST}`);
    expect(other.streamSignal()).toBeNull();
  });

  it('leaves the screen alone and ignores a bad payload or an iTerm2 notification', async () => {
    const m = mirror(20, 3);
    await write(m, `a${ESC}]7501;state=nonsense${BEL}b${ESC}]9;Build done${BEL}c${ESC}]7501;?${ST}`);
    expect(m.screenText().split('\n')[0]).toBe('abc');
    expect(m.streamSignal()).toBeNull();
  });

  it('RIS forgets it; DECSTR and the alternate screen do not', async () => {
    const m = mirror(80, 24);
    await write(m, `${ESC}]7501;state=working:app=opencode${ST}${CSI}!p${CSI}?1049h`);
    expect(m.streamSignal()?.program?.state).toBe('working');
    await write(m, `${ESC}c`);
    expect(m.streamSignal()).toBeNull();
  });
});
