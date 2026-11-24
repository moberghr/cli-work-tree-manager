import { describe, expect, it } from 'vitest';
import { BSU, ESU, SyncScanner, cutAtFrameEnds } from '../../../src/core/pty/sync-output.js';

/** Feed `chunks` in turn; every change, its `at` counted in the whole stream. */
function scan(...chunks: string[]): Array<{ at: number; open: boolean }> {
  const s = new SyncScanner();
  const out: Array<{ at: number; open: boolean }> = [];
  let base = 0;
  for (const c of chunks) {
    for (const ch of s.feed(c)) out.push({ at: base + ch.at, open: ch.open });
    base += c.length;
  }
  return out;
}

describe('SyncScanner', () => {
  it('sees a frame open and close, just past each sequence', () => {
    const text = `a${BSU}frame${ESU}b`;
    expect(scan(text)).toEqual([
      { at: 1 + BSU.length, open: true },
      { at: 1 + BSU.length + 5 + ESU.length, open: false },
    ]);
  });

  it('follows a sequence cut anywhere between chunks', () => {
    const text = `x${BSU}hello${ESU}y`;
    const whole = scan(text);
    for (let cut = 1; cut < text.length; cut++) expect(scan(text.slice(0, cut), text.slice(cut))).toEqual(whole);
    // One character at a time.
    expect(scan(...text.split(''))).toEqual(whole);
  });

  it('sees 2026 among other modes, and with sub-parameters', () => {
    expect(scan('\x1b[?2026;25h').map((c) => c.open)).toEqual([true]);
    expect(scan('\x1b[?25;2026h', '\x1b[?1049;2026;25l').map((c) => c.open)).toEqual([true, false]);
    expect(scan('\x1b[?2026:1h')).toEqual([{ at: 10, open: true }]);
  });

  it('ignores other modes, a query (CSI ? 2026 $ p), the answer to one, and a mode that only starts with 2026', () => {
    expect(scan('\x1b[?25h\x1b[?2026$p\x1b[?2026;2$y\x1b[?20260h\x1b[?202h\x1b[2026h')).toEqual([]);
  });

  it('a second set inside a frame changes nothing; a reset with no frame open is nothing', () => {
    expect(scan(`${ESU}${BSU}${BSU}x${ESU}${ESU}`).map((c) => c.open)).toEqual([true, false]);
  });

  it('RIS (ESC c) ends a frame', () => {
    const s = new SyncScanner();
    s.feed(BSU);
    expect(s.feed('ab\x1bc')).toEqual([{ at: 4, open: false }]);
    expect(s.open).toBe(false);
  });

  it('an ESC inside a sequence starts a new one; overlong parameters are dropped', () => {
    expect(scan('\x1b[?20\x1b[?2026h').map((c) => c.open)).toEqual([true]);
    expect(scan(`\x1b[?${'1;'.repeat(40)}2026h`)).toEqual([]);
  });

  it('reset() forgets an open frame and a sequence half seen', () => {
    const s = new SyncScanner();
    s.feed(`${BSU}\x1b[?20`);
    s.reset();
    expect(s.open).toBe(false);
    expect(s.feed('26h')).toEqual([]);
  });
});

describe('cutAtFrameEnds', () => {
  it('cuts just past each frame end, never at a frame start', () => {
    const s = new SyncScanner();
    const chunk = `a${BSU}one${ESU}b${BSU}two${ESU}c`;
    const pieces = cutAtFrameEnds(s, chunk);
    expect(pieces.join('')).toBe(chunk);
    expect(pieces).toEqual([`a${BSU}one${ESU}`, `b${BSU}two${ESU}`, 'c']);
  });

  it('leaves a chunk with no frame end (or one ending at its end) whole', () => {
    const s = new SyncScanner();
    expect(cutAtFrameEnds(s, `x${BSU}half`)).toEqual([`x${BSU}half`]);
    expect(cutAtFrameEnds(s, `rest${ESU}`)).toEqual([`rest${ESU}`]);
    expect(cutAtFrameEnds(s, 'plain')).toEqual(['plain']);
  });

  it('cuts where an end split across chunks completes', () => {
    const s = new SyncScanner();
    cutAtFrameEnds(s, `${BSU}frame\x1b[?20`);
    expect(cutAtFrameEnds(s, '26lafter')).toEqual(['26l', 'after']);
  });
});
