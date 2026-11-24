import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { GhosttyTerminal } from '../../../../src/core/pty/ghostty/terminal.js';
import { instantiate, wasmPath, WASM_NAME } from '../../../../src/core/pty/ghostty/wasm.js';

const ESC = '\x1b';
const CSI = '\x1b[';
const ST = `${ESC}\\`;

const open: GhosttyTerminal[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.free();
});
function make(cols = 20, rows = 4, events = {}): GhosttyTerminal {
  const t = GhosttyTerminal.create(cols, rows, { scrollback: 100 }, events);
  open.push(t);
  return t;
}

describe('libghostty-vt loader', () => {
  it('finds the vendored module in a source checkout, and checks the exports and struct layout it uses', () => {
    expect(wasmPath()).toBe(path.resolve('vendor/libghostty-vt', WASM_NAME));
    const g = instantiate();
    expect(g.layout.string).toEqual({ ptr: 0, len: 4 });
    expect(g.layout.modeConfig).toEqual({ size: 4, mode: 0, value: 2 });
    expect(g.layout.point).toMatchObject({ size: 24, tag: 0, x: 8, y: 12 });
    expect(g.memory.buffer.byteLength).toBeGreaterThan(0);
  });

  it('gives each terminal an instance of its own', () => {
    const a = make();
    const b = make();
    a.write('one');
    b.write('two');
    expect(a.format({ vt: false, unwrap: false, trim: true })).toBe('one');
    expect(b.format({ vt: false, unwrap: false, trim: true })).toBe('two');
  });
});

describe('GhosttyTerminal', () => {
  it('parses writes at once: cursor, modes, title, kitty flags, the screen', () => {
    const t = make();
    t.write(`ab${CSI}?2004h${CSI}4h${CSI}>5u${ESC}]2;hi${ST}`);
    expect(t.cursor()).toEqual({ x: 2, y: 0, pendingWrap: false });
    expect(t.mode(2004)).toBe(true);
    expect(t.mode(4, true)).toBe(true);
    expect(t.mode(4)).toBe(false); // DEC 4 (smooth scroll) is not ANSI 4 (insert)
    expect(t.kittyKeyboardFlags()).toBe(5);
    expect(t.title()).toBe('hi');
    expect([t.cols, t.rows]).toEqual([20, 4]);
    t.write('x'.repeat(18));
    expect(t.cursor()).toMatchObject({ x: 19, pendingWrap: true });
  });

  it('reports replies, progress, program status and RIS as it parses', () => {
    const seen: string[] = [];
    const t = make(20, 4, {
      reply: (r: string) => seen.push(`reply ${JSON.stringify(r)}`),
      progress: (p: { state: number; percent: number }) => seen.push(`progress ${p.state} ${p.percent}`),
      program: (p: { state: number; app: string }) => seen.push(`program ${p.state} ${p.app}`),
      reset: () => seen.push('reset'),
    });
    t.write(`${CSI}5n${ESC}]9;4;1;40${ST}${ESC}]7501;state=working:app=x${ST}${ESC}c`);
    expect(seen).toEqual([`reply ${JSON.stringify(`${CSI}0n`)}`, 'progress 1 40', 'program 1 x', 'progress 0 -1', 'program 5 ', 'reset']); // RIS: the bar removed, every record cleared, then the reset
  });

  it('formats a range, from the scrollback down, with soft wraps joined or not', () => {
    const t = make(10, 3);
    t.write(`one\r\ntwo\r\n${'w'.repeat(15)}\r\nlast`);
    expect(t.scrollbackRows()).toBe(2);
    const plain = (unwrap: boolean) =>
      t.format({ vt: false, unwrap, trim: true, from: { tag: 'screen', x: 0, y: 1 }, to: { tag: 'active', x: 9, y: 2 } });
    expect(plain(false).split(/\r?\n/)).toEqual(['two', 'wwwwwwwwww', 'wwwww', 'last']);
    expect(plain(true).split(/\r?\n/)).toEqual(['two', 'w'.repeat(15), 'last']);
  });

  it('keeps an unfinished sequence for continuation(), and a clone can be written without touching the original', () => {
    const t = make();
    t.write(`ab${CSI}3`);
    expect(t.ground()).toBe(false);
    expect(t.continuation()).toBe(`${CSI}3`);
    const heard: string[] = [];
    const c = t.clone({ reply: (r) => heard.push(r) });
    c.write(`\x18${ESC}P$qr${ST}${CSI}?1049h`);
    expect(heard).toEqual([`${ESC}P1$r1;4r${ST}`]);
    expect(c.screen()).toBe('alternate');
    expect(t.screen()).toBe('normal');
    c.free();
    t.write(';5Hz');
    expect(t.cursor()).toMatchObject({ x: 5, y: 2 });
  });

  it('is a no-op once freed', () => {
    const t = GhosttyTerminal.create(20, 4, { scrollback: 10 });
    t.free();
    expect(t.alive).toBe(false);
    t.write('x');
    expect(t.resize(10, 10)).toBe(false);
    expect(t.format({ vt: true, unwrap: false, trim: false })).toBe('');
    expect([t.cols, t.title(), t.mode(25), t.continuation()]).toEqual([0, '', false, '']);
    t.free();
  });
});
