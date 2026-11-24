import { describe, it, expect, afterEach } from 'vitest';
import { ScreenMirror } from '../../../src/core/pty/screen-mirror.js';
import { TERMINAL_RESET } from '../../../src/core/pty/terminal-reset.js';

const ESC = '\x1b';
const CSI = '\x1b[';

const open: ScreenMirror[] = [];
afterEach(() => {
  for (const m of open.splice(0)) m.dispose();
});

/** Your own terminal, as `work attach` leaves it: xterm.js, with the mirror's tracking for what xterm.js doesn't report. */
function terminal(): ScreenMirror {
  const m = new ScreenMirror(40, 10);
  open.push(m);
  return m;
}
const write = (m: ScreenMirror, data: string) => new Promise<void>((r) => m.write(data, r));
async function decrqm(m: ScreenMirror, mode: number): Promise<number> {
  let reply = '';
  const sub = m.terminal.onData((d) => (reply += d));
  await write(m, `${CSI}?${mode}$p`);
  sub.dispose();
  return Number(/;(\d)\$y/.exec(reply)?.[1]);
}

/** Every mode an agent can leave on is off (DECRQM 2 = reset), the cursor shown, the keys plain. */
async function expectPlain(m: ScreenMirror) {
  for (const mode of [1, 9, 1000, 1002, 1003, 1004, 1006, 1016, 1049, 2004]) expect(await decrqm(m, mode), `mode ${mode}`).toBe(2);
  expect(await decrqm(m, 25)).toBe(1);
  expect(m.terminal.modes.applicationKeypadMode).toBe(false);
  const s = m.state();
  expect(s.normal.keyboardFlags).toEqual([]);
  expect(s.alternate.keyboardFlags).toEqual([]);
  expect(s).toMatchObject({ modifyOtherKeys: null, cursorStyle: null, cursorHidden: false, charsets: ['B', 'B', 'B', 'B'] });
  expect(s.normal.scrollRegion).toBeNull();
  await write(m, 'x');
  const cell = m.terminal.buffer.active
    .getLine(m.terminal.buffer.active.cursorY + m.terminal.buffer.active.baseY)
    ?.getCell(m.terminal.buffer.active.cursorX - 1);
  expect(cell?.isAttributeDefault()).toBe(true);
}

const MODES = `${CSI}?1h${ESC}=${CSI}?1003h${CSI}?1006h${CSI}?1004h${CSI}?2004h${CSI}?25l${CSI}5 q${CSI}>4;2m${CSI}>1u${CSI}>3u${CSI}4m${ESC}(0`;

describe('TERMINAL_RESET (work attach letting go)', () => {
  it('turns off what an agent on the main screen left on, and leaves the cursor where it was', async () => {
    const m = terminal();
    await write(m, `$ work attach\r\n${MODES}${CSI}2;8r${CSI}6;12H`);
    const [x, y] = [m.terminal.buffer.active.cursorX, m.terminal.buffer.active.cursorY];
    await write(m, TERMINAL_RESET);
    expect([m.terminal.buffer.active.cursorX, m.terminal.buffer.active.cursorY]).toEqual([x, y]);
    await expectPlain(m);
  });

  it('leaves the alternate screen, back where the cursor was before it, with both screens’ keyboard flags gone', async () => {
    const m = terminal();
    await write(m, `$ work attach\r\nagent started${CSI}>1u`);
    const [x, y] = [m.terminal.buffer.active.cursorX, m.terminal.buffer.active.cursorY];
    await write(m, `${CSI}?1049h${MODES}${CSI}3;7r${CSI}5;5H`);
    await write(m, TERMINAL_RESET);
    expect(m.terminal.buffer.active.type).toBe('normal');
    expect([m.terminal.buffer.active.cursorX, m.terminal.buffer.active.cursorY]).toEqual([x, y]);
    await expectPlain(m);
  });

  it('changes nothing visible in a terminal that has nothing on', async () => {
    const m = terminal();
    await write(m, 'plain shell\r\n$ ');
    const before = [m.terminal.buffer.active.cursorX, m.terminal.buffer.active.cursorY];
    await write(m, TERMINAL_RESET);
    expect([m.terminal.buffer.active.cursorX, m.terminal.buffer.active.cursorY]).toEqual(before);
    expect(m.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('plain shell');
    await expectPlain(m);
  });
});
