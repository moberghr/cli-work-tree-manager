import { describe, it, expect, afterEach } from 'vitest';
import xtermHeadless from '@xterm/headless';
import xtermUnicode11 from '@xterm/addon-unicode11';
import { GhosttyMirror, programReport, translateReply } from '../../../src/core/pty/ghostty-mirror.js';
import { ScreenMirror } from '../../../src/core/pty/screen-mirror.js';
import { REPLAY_SCROLLBACK, VIEW_SCROLLBACK } from '../../../src/core/pty/scrollback.js';
import { TerminalColors } from '../../../src/core/pty/terminal-colors.js';
import type { StreamSignal } from '../../../src/core/pty/stream-status.js';

/**
 * The port of screen-mirror.test.ts to the libghostty engine. Each case writes to a GhosttyMirror and, raw, to an
 * xterm.js terminal set up as the browser's; the mirror's snapshot written to a fresh one of those must end the same
 * as the raw one: rows (both screens, scrollback too), cursor, modes, DECRQM replies, scroll region, title. Where the
 * engines differ, the case says so as `it.fails` (or a documented expectation) — never dropped.
 */

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = xtermUnicode11;
type HeadlessTerminal = InstanceType<typeof Terminal>;

const ESC = '\x1b';
const CSI = '\x1b[';
const BEL = '\x07';
const ST = `${ESC}\\`;

const open: { dispose(): void }[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.dispose();
});

function browserLike(cols: number, rows: number): HeadlessTerminal {
  const t = new Terminal({ cols, rows, scrollback: VIEW_SCROLLBACK, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  open.push(t);
  return t;
}

function ghostty(cols: number, rows: number, scrollback?: number): GhosttyMirror {
  const m = new GhosttyMirror(cols, rows, scrollback);
  open.push(m);
  return m;
}

const write = (t: { write(d: string, cb?: () => void): void }, data: string) => new Promise<void>((r) => t.write(data, r));

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
const screen = (t: HeadlessTerminal) => lines(t).slice(-t.rows);
const cursor = (t: HeadlessTerminal) => [t.buffer.active.cursorX, t.buffer.active.cursorY];
function modes(t: HeadlessTerminal) {
  const { synchronizedOutputMode: _sync, ...rest } = t.modes;
  return rest;
}
function titled(t: HeadlessTerminal): () => string | undefined {
  let title: string | undefined;
  t.onTitleChange((x) => (title = x));
  return () => title;
}

/** `input` to a GhosttyMirror and, raw, to a browser-like terminal; the snapshot to a fresh browser-like one. */
async function roundTrip(input: string | string[], cols = 30, rows = 8) {
  const source = ghostty(cols, rows);
  const raw = browserLike(cols, rows);
  const rawTitle = titled(raw);
  for (const chunk of [input].flat()) {
    await write(source, chunk);
    await write(raw, chunk);
  }
  const snap = source.snapshot();
  const target = browserLike(cols, rows);
  const title = titled(target);
  await write(target, snap);
  return { source, raw, target, snap, title, rawTitle, cols, rows };
}

/**
 * Same rows (both screens), cursor, modes, DECRQM replies, region and title as the raw stream left; and a mirror
 * written the snapshot gives the same snapshot (what xterm.js can't report — cursor shape, kitty flags, modifyOtherKeys,
 * charsets — must survive it too).
 */
async function expectSame(r: Awaited<ReturnType<typeof roundTrip>>) {
  const { raw, target, snap } = r;
  expect(target.buffer.active.type).toBe(raw.buffer.active.type);
  expect(lines(target)).toEqual(lines(raw));
  expect(lines(target, 'normal')).toEqual(lines(raw, 'normal'));
  expect(cursor(target)).toEqual(cursor(raw));
  expect(modes(target)).toEqual(modes(raw));
  expect(await modeReplies(target)).toEqual(await modeReplies(raw));
  expect(await regionReply(target)).toEqual(await regionReply(raw));
  expect(r.title()).toBe(r.rawTitle());
  expect(snap).not.toContain('2026');
  const copy = ghostty(r.cols, r.rows);
  await write(copy, snap);
  expect(copy.snapshot()).toBe(snap);
}

describe('GhosttyMirror snapshot round trip', () => {
  const cases: [string, string][] = [
    ['SGR mouse encoding with drag tracking (1006, 1002)', `${CSI}?1002h${CSI}?1006h`],
    ['SGR-pixel mouse encoding with any-motion tracking (1016, 1003)', `${CSI}?1003h${CSI}?1016h`],
    ['X10 mouse (9)', `${CSI}?9h`],
    ['encodings xterm.js ignores after SGR (1006, then 1015 and 1005)', `${CSI}?1000h${CSI}?1006h${CSI}?1015h${CSI}?1005h`],
    ['mouse on and off again', `${CSI}?1000;1006h${CSI}?1000;1006l`],
    ['hidden cursor (25)', `${CSI}?25l`],
    ['blinking bar cursor (DECSCUSR 5)', `${CSI}5 q`],
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
    [
      'colours, bold, a hyperlink and the pen left on',
      `${CSI}1;38;5;202mhot${CSI}0m ${ESC}]8;;https://x.test${ST}link${ESC}]8;;${ST} ${CSI}4;44m`,
    ],
  ];
  for (const [name, input] of cases) {
    it(name, async () => {
      await expectSame(await roundTrip(`some output\r\n${input}`));
    });
  }

  // libghostty keeps one flag per mouse encoding (and protocol) and the API can't say which was set last: they are
  // replayed lowest first. xterm.js has one encoding: 1016l after 1006h,1016h is the default there, 1006 here.
  it.fails('an encoding reset after another was set (1016 then 1016l)', async () => {
    await expectSame(await roundTrip(`some output\r\n${CSI}?1006h${CSI}?1016h${CSI}?1016l`));
  });
  it.fails('mouse protocols set highest first (1002 then 1000: xterm.js ends on 1000)', async () => {
    await expectSame(await roundTrip(`${CSI}?1002h${CSI}?1000h`));
  });

  // libghostty keeps the blink in the cursor shape (6 q then ?12h reads back as 5 q), so the snapshot says the shape
  // only: the cursor blinks the same, but xterm.js's DECRQM 12 — set only by ?12h itself — reads reset.
  it.fails('cursor shape and blink (DECSCUSR, 12)', async () => {
    await expectSame(await roundTrip(`some output\r\n${CSI}5 q${CSI}?12h`));
  });

  it('the title reaches a fresh terminal (OSC 2)', async () => {
    const r = await roundTrip(`${ESC}]2;✳ fixing the build${BEL}`);
    expect(r.title()).toBe('✳ fixing the build');
    await expectSame(r);
  });

  it('a waiting wrap still wraps: the next character goes on the next row', async () => {
    for (const input of ['x'.repeat(30), `${'\r\n'.repeat(7)}${'y'.repeat(30)}`]) {
      const r = await roundTrip(input);
      await write(r.raw, 'Z');
      await write(r.target, 'Z');
      expect(lines(r.target)).toEqual(lines(r.raw));
      expect(cursor(r.target)).toEqual(cursor(r.raw));
    }
  });

  it('what comes after a snapshot draws the same: line drawing, the saved cursor, a region in origin mode', async () => {
    for (const [input, after] of [
      [`${ESC}(0`, 'qqq'],
      [`${CSI}3;4H${ESC}7${CSI}1;1H`, `${ESC}8!`],
      [`${CSI}2;6r${CSI}?6h${CSI}2;3H`, 'ab\r\n\r\n\r\n\r\n\r\ncd'],
    ]) {
      const r = await roundTrip(input);
      await write(r.raw, after);
      await write(r.target, after);
      expect(lines(r.target)).toEqual(lines(r.raw));
      expect(cursor(r.target)).toEqual(cursor(r.raw));
    }
  });

  const agent = {
    normal: `${CSI}31mbuild ok${CSI}0m\r\n$ agent\r\n${CSI}>1u${CSI}1;6r${CSI}4;2H${ESC}7`,
    enter: `${CSI}?1049h${CSI}?1000h${CSI}?1002h${CSI}?1006h${CSI}?2004h${CSI}?1004h${CSI}?25l${CSI}5 q${ESC}]2;agent${ESC}\\${CSI}>3u${CSI}2;7r`,
    frame: Array.from({ length: 8 }, (_, i) => `${CSI}${i + 1};1H${CSI}3${i % 8}m row ${i} ${CSI}0m│ 👍 ✅`).join(''),
  };

  it('a full-screen agent: alternate screen, mouse, paste, focus, hidden cursor, shape, title, flags, region', async () => {
    const r = await roundTrip([agent.normal, agent.enter, agent.frame, `${CSI}?2026h${CSI}4;6H`]);
    expect(r.raw.buffer.active.type).toBe('alternate');
    await expectSame(r);
    expect(r.title()).toBe('agent');
    expect(r.snap).toContain(`${CSI}>1u${CSI}?1049h`); // the normal screen's kitty flags, then its own
    expect(r.snap).toContain(`${CSI}>3u`);
    // Leaving the alternate screen afterwards lands both where the app left the normal one.
    await write(r.raw, `${CSI}?1049l`);
    await write(r.target, `${CSI}?1049l`);
    expect(lines(r.target)).toEqual(lines(r.raw));
    expect(cursor(r.target)).toEqual(cursor(r.raw));
  });

  // libghostty keeps one scroll region for both screens (xterm.js one per buffer): the normal screen's own region, set
  // before the alternate one, is gone from it, so the snapshot can't say it.
  it.fails('the normal screen keeps its own scroll region under the alternate one', async () => {
    const r = await roundTrip([agent.normal, agent.enter, agent.frame]);
    await write(r.raw, `${CSI}?1049l`);
    await write(r.target, `${CSI}?1049l`);
    expect(await regionReply(r.target)).toEqual(await regionReply(r.raw));
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

  it('carries REPLAY_SCROLLBACK lines above the screen (libghostty is given twice that: it drops whole pages)', async () => {
    const m = ghostty(30, 8);
    await write(m, Array.from({ length: REPLAY_SCROLLBACK + 3000 }, (_, i) => `l${i}`).join('\r\n'));
    const t = browserLike(30, 8);
    await write(t, m.snapshot());
    expect(t.buffer.active.length).toBe(REPLAY_SCROLLBACK + 8);
    expect(lines(t).at(-1)).toBe(`l${REPLAY_SCROLLBACK + 2999}`);
  });

  it('measures emoji, CJK, ZWJ and VS16 text as the browser does (Unicode 11)', async () => {
    // Measured the same by both (mode 2027, grapheme clustering, stays off): the ZWJ family is its three emoji, 6
    // columns; VS16 doesn't widen ❤️ ☀️ ⚠️ ✔️.
    const r = await roundTrip(`👍⭐✅⏳🚀|\r\na一二b|\r\n👨‍👩‍👧|\r\n❤️ ☀️|\r\n⚠️ ✔️|\r\né|`, 40, 8);
    await expectSame(r);
  });

  // A flag is two regional indicators: 2 columns each to libghostty, 1 each to xterm.js's Unicode 11 (the browser).
  // The row's text is the same, but the cursor (and anything drawn by position after the flag) is 2 columns apart.
  it.fails('a flag (regional indicators) is as wide as xterm.js says', async () => {
    await expectSame(await roundTrip('🇭🇷 é|', 40, 6));
  });

  // A zero-width character with nothing before it on the row: xterm.js keeps it in the row's text, libghostty drops it
  // (the cursor and every cell after it are the same).
  it.fails('a zero-width space at the start of a row', async () => {
    await expectSame(await roundTrip('​|', 40, 6));
  });

  it('never puts synchronized output (2026) in a snapshot', async () => {
    const r = await roundTrip(`${CSI}?2026hhalf a frame`);
    expect(r.raw.modes.synchronizedOutputMode).toBe(true);
    expect(r.snap).not.toContain('2026');
    expect(r.target.modes.synchronizedOutputMode).toBe(false);
    await expectSame(r);
  });

  const beforeRis = `${CSI}?1006h${CSI}5 q${CSI}>1u${CSI}>4;2m${CSI}?1007l${CSI}2;5r${ESC}(0${ESC}7${ESC}]2;t${ESC}\\`;

  it('RIS forgets the modes, shape, flags, region, charsets and saved cursor', async () => {
    const r = await roundTrip(`${beforeRis}${ESC}c`);
    for (const gone of ['?1006h', '5 q', '>1u', '>4;2m', '1007', `${ESC}(0`, `${ESC}7${CSI}`]) expect(r.snap.slice(20)).not.toContain(gone);
    expect(lines(r.target)).toEqual(lines(r.raw));
    expect(cursor(r.target)).toEqual(cursor(r.raw));
    expect(await modeReplies(r.target)).toEqual(await modeReplies(r.raw));
  });

  // xterm.js 6 keeps the title and a hidden cursor through RIS; libghostty clears the title and shows the cursor.
  it.fails('RIS keeps the title, as xterm.js does', async () => {
    const r = await roundTrip(`${beforeRis}${ESC}c`);
    expect(r.title()).toBe('t');
  });
  it.fails('RIS keeps a hidden cursor hidden, as xterm.js does', async () => {
    const r = await roundTrip(`${CSI}?25l${ESC}c`);
    expect(await ask(r.target, `${CSI}?25$p`)).toBe(await ask(r.raw, `${CSI}?25$p`));
  });

  it('DECSTR puts back the cursor, region, saved cursor and character sets, and keeps the mouse', async () => {
    const r = await roundTrip(`${CSI}?1002;1006h${CSI}?25l${CSI}2;5r${CSI}4 q${ESC}(0${CSI}3;3H${ESC}7${CSI}!p`);
    expect(r.raw.modes.mouseTrackingMode).toBe('drag');
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
    const copy = ghostty(30, 8);
    await write(copy, once.snap);
    expect(copy.snapshot()).toBe(once.snap);
  });

  it('a sequence split across writes is read whole', async () => {
    const whole = `${CSI}?1006h${CSI}?25l${CSI}5 q${CSI}>4;2m${ESC}]2;split${ESC}\\${CSI}>7u`;
    const r = await roundTrip(whole.split(''));
    expect(r.snap).toContain(`${CSI}5 q`);
    expect(r.snap).toContain(`${CSI}>7u`);
    expect(r.snap).toContain(`${CSI}>4;2m`);
    await expectSame(r);
  });

  it('a resize puts the scroll region back, as xterm.js does', async () => {
    const m = ghostty(30, 8);
    await write(m, `${CSI}2;5r`);
    m.resize(30, 10);
    const t = browserLike(30, 10);
    await write(t, m.snapshot());
    expect(await regionReply(t)).toBe(`${ESC}P1$r1;10r${ESC}\\`);
  });

  it('leaving the alternate screen forgets its kitty flags', async () => {
    const r = await roundTrip(`${CSI}?1049h${CSI}>3u${CSI}?1049l`);
    expect(r.snap).not.toContain('>3u');
    await expectSame(r);
  });

  it('a snapshot taken mid-sequence ends with what came of it, so the rest of the sequence continues it', async () => {
    const m = ghostty(30, 8);
    await write(m, `before${CSI}3`);
    const snap = m.snapshot();
    expect(snap.endsWith(`${CSI}3`)).toBe(true);
    const t = browserLike(30, 8);
    await write(t, snap + ';5Hafter');
    const raw = browserLike(30, 8);
    await write(raw, `before${CSI}3;5Hafter`);
    expect(screen(t)).toEqual(screen(raw));
    expect(cursor(t)).toEqual(cursor(raw));
  });
});

describe('GhosttyMirror resize and writes: parsed in the call, in order', () => {
  const frameFor40 = `${'x'.repeat(40)}${CSI}2;1Hnext`;

  it('output written before a resize is drawn for the grid it was written for, then reflowed', async () => {
    const m = ghostty(40, 5);
    m.write(frameFor40);
    m.resize(20, 5);
    const shot = await m.snapshotSettled();
    expect(m.screenText().split('\n').slice(0, 3)).toEqual(['x'.repeat(20), 'x'.repeat(20), 'next']);
    expect(m.size()).toEqual({ cols: 20, rows: 5 });
    expect(shot).toContain('next');
  });

  it('applies at once; the same grid again changes nothing', () => {
    const m = ghostty(40, 5);
    m.write('settled');
    m.resize(30, 6);
    expect(m.size()).toEqual({ cols: 30, rows: 6 });
    m.resize(30, 6);
    expect(m.size()).toEqual({ cols: 30, rows: 6 });
    expect(m.screenText().split('\n')).toHaveLength(6);
  });

  it('two resizes apply in order', async () => {
    const m = ghostty(40, 5);
    m.write(frameFor40);
    m.resize(20, 5);
    m.resize(50, 7);
    await m.snapshotSettled();
    expect(m.size()).toEqual({ cols: 50, rows: 7 });
  });

  it('done callbacks run in the order written, after the write returns (never inside it)', async () => {
    const m = ghostty(40, 5);
    const order: string[] = [];
    m.write('a', () => order.push('a'));
    m.write('b', () => {
      order.push('b');
      m.write('c', () => order.push('c')); // a write from a callback is not re-entered into the one before
    });
    order.push('returned');
    await write(m, '');
    await Promise.resolve();
    expect(order).toEqual(['returned', 'a', 'b', 'c']);
    expect(m.screenText().split('\n')[0]).toBe('abc');
  });

  // ScreenMirror's snapshotSettled waits for xterm's parse, and a dispose in between makes it ''. Here nothing waits:
  // a snapshot asked for before the dispose is taken then. After it, everything is '' and nothing throws.
  it('disposed: the instance is dropped and every call after is a no-op', async () => {
    const m = new GhosttyMirror(40, 5);
    m.write('x'.repeat(100_000));
    const shot = m.snapshotSettled();
    m.dispose();
    expect(await shot).toContain('xxx');
    expect(await m.snapshotSettled()).toBe('');
    expect(m.snapshot()).toBe('');
    expect(m.screenText()).toBe('');
    expect(m.size()).toEqual({ cols: 0, rows: 0 });
    let done = false;
    m.write('more', () => (done = true));
    m.resize(10, 10);
    m.dispose();
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

describe('a screen-only GhosttyMirror snapshot (scrollback: false): the catch-up screen work attach is sent', () => {
  const history = Array.from({ length: 300 }, (_, i) => `${CSI}38;5;${i % 256}mline ${i}${CSI}0m`).join('\r\n');

  async function screenOnly(input: string | string[], cols = 30, rows = 8) {
    const source = ghostty(cols, rows);
    const raw = browserLike(cols, rows);
    for (const chunk of [input].flat()) {
      await write(source, chunk);
      await write(raw, chunk);
    }
    const snap = source.snapshot({ scrollback: false });
    const fresh = browserLike(cols, rows);
    await write(fresh, snap);
    const used = browserLike(cols, rows);
    await write(used, Array.from({ length: 20 }, (_, i) => `shell ${i}`).join('\r\n') + `\r\n${CSI}?1049h${CSI}?1000h${CSI}5;5Hstale`);
    await write(used, `${CSI}2J${CSI}H` + snap);
    return { source, raw, fresh, used, snap, cols, rows };
  }
  async function expectSameScreen(r: Awaited<ReturnType<typeof screenOnly>>) {
    for (const t of [r.fresh, r.used]) {
      expect(t.buffer.active.type).toBe(r.raw.buffer.active.type);
      expect(screen(t)).toEqual(screen(r.raw));
      expect(lines(t, 'normal').slice(-t.rows)).toEqual(lines(r.raw, 'normal').slice(-r.raw.rows));
      expect(cursor(t)).toEqual(cursor(r.raw));
      expect(modes(t)).toEqual(modes(r.raw));
      expect(await modeReplies(t)).toEqual(await modeReplies(r.raw));
      expect(await regionReply(t)).toEqual(await regionReply(r.raw));
    }
    const copy = ghostty(r.cols, r.rows);
    await write(copy, r.snap);
    expect(copy.snapshot({ scrollback: false })).toBe(r.snap);
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

  it('the saved cursor, the scroll region and origin mode land where they were on the screen', async () => {
    for (const [input, after] of [
      [`${history}\r\n${CSI}3;4H${ESC}7${CSI}8;1H$ prompt`, `${ESC}8X`],
      [`${history}\r\n${CSI}5;9H${CSI}s${CSI}2;2H`, `${CSI}uY`],
      [`${history}\r\n${CSI}2;6r${CSI}?6h${CSI}2;3Hab`, 'cd\r\n\r\n\r\n\r\n\r\nef'],
    ]) {
      const r = await screenOnly(input);
      await expectSameScreen(r);
      for (const t of [r.raw, r.fresh, r.used]) await write(t, after);
      for (const t of [r.fresh, r.used]) {
        expect(screen(t)).toEqual(screen(r.raw));
        expect(cursor(t)).toEqual(cursor(r.raw));
      }
    }
  });

  it('a full-screen agent over a normal screen with history: both screens, and leaving the alternate one lands the same', async () => {
    const normal = `${history}\r\n$ agent\r\n${CSI}>1u${CSI}4;2H${ESC}7`;
    const enter = `${CSI}?1049h${CSI}?1002;1006h${CSI}?2004h${CSI}?25l${CSI}5 q${CSI}>3u${CSI}2;7r`;
    const frame = Array.from({ length: 8 }, (_, i) => `${CSI}${i + 1};1H${CSI}3${i % 8}m row ${i} ${CSI}0m│ 👍 ✅`).join('');
    const r = await screenOnly([normal, enter, frame, `${CSI}4;6H`]);
    expect(r.raw.buffer.active.type).toBe('alternate');
    await expectSameScreen(r);
    for (const t of [r.raw, r.fresh, r.used]) await write(t, `${CSI}?1049l`);
    for (const t of [r.fresh, r.used]) {
      expect(screen(t)).toEqual(screen(r.raw));
      expect(cursor(t)).toEqual(cursor(r.raw));
    }
  });

  it('settled, as the catch-up takes it', async () => {
    const m = ghostty(30, 8);
    m.write(`${history}\r\nlast`);
    const snap = await m.snapshotSettled({ scrollback: false });
    expect(snap).toContain('last');
    expect(snap).not.toContain('line 100');
  });
});

describe('GhosttyMirror answering queries', () => {
  function answering(now: () => boolean) {
    const m = ghostty(80, 24);
    const sent: string[] = [];
    m.answerQueries({ now, send: (r) => sent.push(r), colors: new TerminalColors() });
    return { m, sent };
  }

  it('answers nothing unless told to (no answers given, or output written while a client is attached)', async () => {
    const quiet = ghostty(80, 24);
    await write(quiet, `${CSI}c${CSI}6n`);
    const { m, sent } = answering(() => false);
    await write(m, `${CSI}c${CSI}6n${ESC}]11;?${ESC}\\`);
    expect(sent).toEqual([]);
  });

  it('decides as the output arrives', async () => {
    let nobody = true;
    const { m, sent } = answering(() => nobody);
    m.write(`${CSI}5n`);
    nobody = false;
    m.write(`${CSI}c`);
    nobody = true;
    await write(m, `${ESC}]12;?${BEL}`);
    expect(sent).toEqual([`${CSI}0n`, `${ESC}]12;rgb:ffff/ffff/ffff${ESC}\\`]);
  });

  it('answers DA1, DA2, DSR, CPR, DECRQM and DECRQSS as xterm.js does', async () => {
    const xterm = browserLike(80, 24);
    const queries = [
      `${CSI}c`,
      `${CSI}>c`,
      `${CSI}5n`,
      `${CSI}3;7H${CSI}6n`,
      `${CSI}?2004h${CSI}?2004$p`,
      `${CSI}?1$p`,
      `${CSI}2;9r${ESC}P$qr${ST}`,
    ];
    for (const q of queries) {
      const { m, sent } = answering(() => true);
      await write(m, q);
      expect([sent.join(''), q]).toEqual([await ask(xterm, q), q]);
    }
  });

  // xterm.js answers DECRQSS for SGR and DECSCUSR in its own words; libghostty in its own. Passed on as they are.
  it('DECRQSS for the pen and the cursor shape: libghostty words them its own way', async () => {
    const { m, sent } = answering(() => true);
    await write(m, `${CSI}1;31m${ESC}P$qm${ST}${CSI}3 q${ESC}P$q q${ST}`);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(`${ESC}P1$r3 q${ST}`);
  });

  it('never answers XTVERSION, DA3, XTGETTCAP, the kitty flags query or the OSC 7501 probe', async () => {
    const { m, sent } = answering(() => true);
    await write(m, `${CSI}>0q${CSI}=c${ESC}P+q544e${ST}${CSI}?u${ESC}]7501;?${ST}`);
    expect(sent).toEqual([]);
    for (const reply of [
      `${ESC}P>|libghostty${ST}`,
      `${ESC}P!|00000000${ST}`,
      `${ESC}P1+r544e${ST}`,
      `${CSI}?0u`,
      `${ESC}]7501;v=1${ST}`,
    ]) {
      expect(translateReply(reply, new TerminalColors())).toBeNull();
    }
  });

  it('answers OSC 10;?;? as two queries and OSC 4 index;? pairs, ignoring a colour being set', async () => {
    const { m, sent } = answering(() => true);
    await write(m, `${ESC}]10;?;?${ESC}\\${ESC}]4;0;?;15;#fff;16;?${ESC}\\${ESC}]10;#123456${ESC}\\${ESC}]10;?${BEL}`);
    expect(sent).toEqual([
      `${ESC}]10;rgb:d4d4/d4d4/d4d4${ESC}\\`,
      `${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`,
      `${ESC}]4;0;rgb:2e2e/3434/3636${ESC}\\`,
      `${ESC}]4;16;rgb:0000/0000/0000${ESC}\\`,
      `${ESC}]10;rgb:d4d4/d4d4/d4d4${ESC}\\`,
    ]);
  });

  // xterm.js skips an index past 255 and answers the pairs after it; libghostty stops at it.
  it.fails('OSC 4 answers the pairs after an index out of range', async () => {
    const { m, sent } = answering(() => true);
    await write(m, `${ESC}]4;0;?;300;?;16;?${ESC}\\`);
    expect(sent).toEqual([`${ESC}]4;0;rgb:2e2e/3434/3636${ESC}\\`, `${ESC}]4;16;rgb:0000/0000/0000${ESC}\\`]);
  });
});

describe('GhosttyMirror on ConPTY (windowsPty)', () => {
  // libghostty has no resize without reflow: windowsPty only stops a resize pulling lines back from the scrollback.
  // ConPTY reflows the lines itself as well, so on Windows a narrowed screen is reflowed twice (documented gap).
  it('constructs with windowsPty, and still reflows the screen on a resize', () => {
    const m = new GhosttyMirror(40, 5, undefined, { windowsPty: { backend: 'conpty', buildNumber: 19045 } });
    open.push(m);
    m.write('x'.repeat(40));
    m.resize(20, 5);
    expect(m.screenText().split('\n').slice(0, 2)).toEqual(['x'.repeat(20), 'x'.repeat(20)]);
  });
});

describe('GhosttyMirror in-band status (libghostty parses OSC 9;4 and OSC 7501 itself)', () => {
  it('OSC 7501 and OSC 9;4 with either terminator, split anywhere across writes', async () => {
    const m = ghostty(80, 24);
    const report = `${ESC}]7501;state=blocked:app=codex:kind=permission${ST}`;
    for (const piece of [report.slice(0, 3), report.slice(3, 20), report.slice(20, -1), report.slice(-1)]) await write(m, piece);
    expect(m.streamSignal()?.program).toMatchObject({ state: 'blocked', kind: 'permission', app: 'codex' });

    const other = ghostty(80, 24);
    await write(other, `text ${ESC}]9;4;1;`);
    await write(other, `55${BEL} more text`);
    expect(other.streamSignal()?.progress).toMatchObject({ state: 1, percent: 55 });
    await write(other, `${ESC}]9;4;0;${ST}`);
    expect(other.streamSignal()).toBeNull();
  });

  it('leaves the screen alone and ignores a bad payload or an iTerm2 notification', async () => {
    const m = ghostty(20, 3);
    await write(m, `a${ESC}]7501;state=nonsense${BEL}b${ESC}]9;Build done${BEL}c${ESC}]7501;?${ST}`);
    expect(m.screenText().split('\n')[0]).toBe('abc');
    expect(m.streamSignal()).toBeNull();
  });

  it('RIS forgets it; DECSTR and the alternate screen do not', async () => {
    const m = ghostty(80, 24);
    await write(m, `${ESC}]7501;state=working:app=opencode${ST}${CSI}!p${CSI}?1049h`);
    expect(m.streamSignal()?.program?.state).toBe('working');
    await write(m, `${ESC}c`);
    expect(m.streamSignal()).toBeNull();
  });

  /** What both engines say after `data`, without the times. */
  async function both(data: string): Promise<[unknown, unknown]> {
    const strip = (s: StreamSignal | null) =>
      s && {
        ...(s.program ? { program: { ...s.program, since: undefined } } : {}),
        ...(s.progress ? { progress: { ...s.progress, since: undefined } } : {}),
      };
    const x = new ScreenMirror(80, 24);
    open.push(x);
    const g = ghostty(80, 24);
    await write(x, data);
    await write(g, data);
    return [strip(g.streamSignal()), strip(x.streamSignal())];
  }
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const same: [string, string][] = [
    ['working with a percentage', `${ESC}]7501;state=working:app=claude:progress=42${ST}`],
    ['blocked on a question with a message', `${ESC}]7501;state=blocked:kind=question:msg=${b64('Pick one')}${ST}`],
    ['a child record, then the root', `${ESC}]7501;id=a/b:state=working${ST}${ESC}]7501;state=idle${ST}`],
    ['clear of the root', `${ESC}]7501;state=working${ST}${ESC}]7501;state=clear${ST}`],
    ['an unknown state', `${ESC}]7501;state=bogus${ST}`],
    ['a kind with a state that takes none', `${ESC}]7501;state=working:kind=question${ST}`],
    ['progress set, then indeterminate keeps the percent', `${ESC}]9;4;1;30${ST}${ESC}]9;4;3${ST}`],
    ['progress over 100', `${ESC}]9;4;1;150${ST}`],
    ['progress error with no percent keeps the last', `${ESC}]9;4;1;20${ST}${ESC}]9;4;2${ST}`],
    ['progress after a program report is not followed', `${ESC}]7501;state=done${ST}${ESC}]9;4;1;20${ST}`],
  ];
  for (const [name, data] of same) {
    it(`reads as stream-status.ts does: ${name}`, async () => {
      const [g, x] = await both(data);
      expect(g).toEqual(x);
    });
  }

  it('turns libghostty’s parsed reports into stream-status records', () => {
    const base = { kind: 0, progress: -1, id: '', app: '', title: '', message: '' };
    expect(programReport({ ...base, state: 3, kind: 1, progress: 10, app: 'codex' })).toEqual({
      id: '',
      state: 'blocked',
      kind: 'permission',
      progress: 10,
      app: 'codex',
    });
    expect(programReport({ ...base, state: 5, id: 'a' })).toEqual({ state: 'clear', id: 'a' });
    expect(programReport({ ...base, state: 9 })).toBeUndefined();
    expect(programReport({ ...base, state: 0, kind: 2, progress: 50 })).toEqual({ id: '', state: 'idle' });
  });
});
