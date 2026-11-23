import { describe, it, expect } from 'vitest';
import { OutputTail, RESUME_TAIL_CHARS, resumeFrom, type ResumeTarget } from '../../../src/core/pty/output-tail.js';
import { HIGH_WATERMARK } from '../../../src/core/pty/flow-control.js';
import type { ResumePoint } from '../../../src/core/pty/resume.js';

const tailOf = (max: number, ...chunks: string[]) => {
  const t = new OutputTail(max);
  for (const c of chunks) t.push(c);
  return t;
};

describe('OutputTail', () => {
  it('holds everything while it fits, and says where it stands', () => {
    const t = tailOf(100, 'abc', 'def');
    expect([t.start, t.end]).toEqual([0, 6]);
    expect(t.since(0)).toBe('abcdef');
    expect(t.since(2)).toBe('cdef');
    expect(t.since(3)).toBe('def');
    expect(t.since(6)).toBe('');
  });

  it('keeps the last `max` characters, cutting a chunk where the bound falls, and counts everything', () => {
    const t = tailOf(5, 'abc', 'def', 'gh');
    expect([t.start, t.end]).toEqual([3, 8]);
    expect(t.since(3)).toBe('defgh');
    expect(t.since(4)).toBe('efgh');
    t.push('ijklmnopq'); // one chunk longer than the tail
    expect([t.start, t.end]).toEqual([12, 17]);
    expect(t.since(12)).toBe('mnopq');
  });

  it('what falls before it, or past its end, is not held (null), never a part of it', () => {
    const t = tailOf(5, 'abcdefgh');
    expect(t.since(2)).toBeNull();
    expect(t.since(9)).toBeNull();
    expect(t.since(-1)).toBeNull();
    expect(t.since(1.5)).toBeNull();
    expect(t.since(3)).toBe('defgh');
  });

  it('its cut may fall mid-escape or mid-surrogate: it is only ever read from an offset a client stands at', () => {
    const t = tailOf(4, 'x\x1b[31m', '😀z'); // 'x' ESC [ 3 1 m, then a surrogate pair and z
    expect(t.start).toBe(5);
    // From its start: half an escape and half a pair, which is why since() of an offset before is refused, and resumeFrom refuses a split pair.
    expect(t.since(5)).toBe('m😀z');
    expect(t.since(6)).toBe('😀z');
  });

  it('many small pushes stay bounded and exact (it compacts its chunks)', () => {
    const t = new OutputTail(100);
    let all = '';
    for (let i = 0; i < 5000; i++) {
      const s = String(i % 10);
      t.push(s);
      all += s;
    }
    expect(t.end).toBe(5000);
    expect(t.since(4900)).toBe(all.slice(4900));
    expect(t.since(4899)).toBeNull();
  });

  it('clear() holds nothing more but keeps counting', () => {
    const t = tailOf(100, 'abc');
    t.clear();
    expect([t.start, t.end]).toEqual([3, 3]);
    expect(t.since(0)).toBeNull();
    t.push('de');
    expect(t.since(3)).toBe('de');
  });

  it('is sized under what a client may have outstanding (HIGH_WATERMARK)', () => {
    expect(RESUME_TAIL_CHARS).toBeLessThan(HIGH_WATERMARK);
  });
});

describe('resumeFrom (any doubt is a screen)', () => {
  const at = (offset: number, over: Partial<ResumePoint> = {}): ResumePoint => ({
    stream: 'abcdef0123456789',
    offset,
    cols: 80,
    rows: 24,
    ...over,
  });
  const target = (over: Partial<ResumeTarget> = {}): ResumeTarget => ({
    stream: 'abcdef0123456789',
    grid: { cols: 80, rows: 24 },
    gridBefore: { cols: 80, rows: 24 },
    gridAt: 0,
    busy: false,
    ...over,
  });
  const tail = tailOf(10, 'hello ', 'world!'); // 0..12, holds 2..12

  it('sends what it missed, from exactly where it stands', () => {
    expect(resumeFrom(at(6), target(), tail)).toEqual({ missed: 'world!' });
    expect(resumeFrom(at(12), target(), tail)).toEqual({ missed: '' });
  });

  it('another stream (another process, another host): a screen', () => {
    expect(resumeFrom(at(6, { stream: '0123456789abcdef' }), target(), tail)).toEqual({ refused: 'stream' });
  });

  it('exiting, restarting, halted or redrawing: a screen', () => {
    expect(resumeFrom(at(6), target({ busy: true }), tail)).toEqual({ refused: 'busy' });
  });

  it('its grid is not the PTY’s, was not before this attach, or is not the one it states: a screen', () => {
    expect(resumeFrom(at(6), target({ grid: { cols: 100, rows: 24 } }), tail)).toEqual({ refused: 'grid' });
    expect(resumeFrom(at(6), target({ gridBefore: { cols: 80, rows: 30 } }), tail)).toEqual({ refused: 'grid' });
    expect(resumeFrom(at(6), target(), tail, { cols: 80, rows: 23 })).toEqual({ refused: 'grid' });
    expect(resumeFrom(at(6), target(), tail, { cols: 80, rows: 24 })).toEqual({ missed: 'world!' });
  });

  it('the grid changed after its offset (it raced a resize, or a redraw jiggled it): a screen', () => {
    expect(resumeFrom(at(6), target({ gridAt: 7 }), tail)).toEqual({ refused: 'resized' });
    // A change at or before where it stands, it saw (its own grid since): fine.
    expect(resumeFrom(at(6), target({ gridAt: 6 }), tail)).toEqual({ missed: 'world!' });
  });

  it('too old for the tail: a screen', () => {
    expect(resumeFrom(at(1), target(), tail)).toEqual({ refused: 'too-old' });
  });

  it('ahead of the stream: a screen', () => {
    expect(resumeFrom(at(13), target(), tail)).toEqual({ refused: 'ahead' });
  });

  it('an offset between the halves of a surrogate pair is no frame end: a screen', () => {
    const t = tailOf(100, 'a😀b');
    expect(resumeFrom(at(2), target(), t)).toEqual({ refused: 'split' });
    expect(resumeFrom(at(1), target(), t)).toEqual({ missed: '😀b' });
    expect(resumeFrom(at(3), target(), t)).toEqual({ missed: 'b' });
  });
});
