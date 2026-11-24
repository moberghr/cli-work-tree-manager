import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { RepaintScroll, REPAINT_QUIET_MS, REPAINT_SETTLE_MS, type RepaintTimers } from '../../src/web/src/state/repaint-scroll.js';

/** A clock and timers moved by hand. */
class Clock implements RepaintTimers {
  private t = 0;
  private next = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  set(fn: () => void, ms: number): unknown {
    this.due.set(++this.next, { at: this.t + ms, fn });
    return this.next;
  }
  clear(id: unknown): void {
    this.due.delete(id as number);
  }
  /** Timers set and not yet fired or cleared. */
  pending(): number {
    return this.due.size;
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, d] of [...this.due])
      if (d.at <= this.t) {
        this.due.delete(id);
        d.fn();
      }
  }
}

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}\r\n`).join('');
const REPRINT = '\x1b[2J\x1b[3J\x1b[H';

function setup() {
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
  const clock = new Clock();
  const repaint = new RepaintScroll(term, clock);
  /** Writes like PtyView: the hook runs once xterm has parsed the write. */
  const write = (data: string) =>
    new Promise<void>((resolve) =>
      term.write(data, () => {
        repaint.written();
        resolve();
      }),
    );
  const top = () => term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true);
  return { term, clock, repaint, write, top };
}

describe('RepaintScroll', () => {
  it('keeps a view scrolled up on the same line through a repaint with no frame around it that comes in several writes', async () => {
    const { term, clock, write, top } = setup();
    await write(lines(0, 200));
    term.scrollToLine(100);
    expect(top()).toBe('line 100');
    // The first read of a quiet moment is sent alone: the erase and a few lines, then the rest.
    await write(REPRINT + lines(0, 20));
    clock.advance(5);
    await write(lines(20, 120));
    clock.advance(5);
    await write(lines(120, 200));
    expect(top()).toBe('line 100');
    clock.advance(REPAINT_QUIET_MS);
    expect(top()).toBe('line 100');
  });

  it('keeps a view at the bottom at the bottom', async () => {
    const { term, write } = setup();
    await write(lines(0, 200));
    await write(REPRINT + lines(0, 20));
    await write(lines(20, 200));
    const b = term.buffer.active;
    expect(b.viewportY).toBe(b.baseY);
  });

  it('gives the view back once the writes stop, and at the latest REPAINT_SETTLE_MS after the repaint began', async () => {
    const { term, clock, write, top } = setup();
    await write(lines(0, 200));
    term.scrollToLine(100);
    await write(REPRINT + lines(0, 200));
    // Output goes on without a pause: the view is followed until REPAINT_SETTLE_MS, then left to you.
    let n = 200;
    for (let t = 0; t < REPAINT_SETTLE_MS; t += REPAINT_QUIET_MS / 2) {
      clock.advance(REPAINT_QUIET_MS / 2);
      await write(lines(n, n + 5));
      n += 5;
    }
    expect(top()).toBe('line 100');
    term.scrollToLine(50);
    await write(lines(n, n + 5));
    expect(top()).toBe('line 50');
  });

  it('puts a synchronized repaint right when its frame ends, not after each write', async () => {
    const { term, write, top } = setup();
    await write(lines(0, 200));
    term.scrollToLine(100);
    await write('\x1b[?2026h' + REPRINT + lines(0, 20));
    await write(lines(20, 200));
    await write('\x1b[?2026l');
    expect(top()).toBe('line 100');
  });

  describe('the quiet timer', () => {
    it('is released once the writes stop: a view the user moves afterwards is not pulled back', async () => {
      const { term, clock, write, top } = setup();
      await write(lines(0, 200));
      term.scrollToLine(100);
      await write(REPRINT + lines(0, 20));
      clock.advance(5);
      await write(lines(20, 200));
      clock.advance(REPAINT_QUIET_MS);
      expect(top()).toBe('line 100');
      term.scrollToLine(50);
      await write(lines(200, 205));
      expect(top()).toBe('line 50');
    });

    it('is restarted by a write inside the window: the repaint is not over until the writes stop for REPAINT_QUIET_MS', async () => {
      const { term, clock, write, top } = setup();
      await write(lines(0, 200));
      term.scrollToLine(100);
      await write(REPRINT + lines(0, 20));
      clock.advance(REPAINT_QUIET_MS - 10);
      await write(lines(20, 120)); // restarts it: the first timer would have fired 10 ms from now
      clock.advance(20);
      // Still within the repaint: the view is placed again by the next write, so moving it is undone.
      term.scrollToLine(50);
      await write(lines(120, 200));
      expect(top()).toBe('line 100');
      clock.advance(REPAINT_QUIET_MS);
      term.scrollToLine(50);
      await write(lines(200, 205));
      expect(top()).toBe('line 50');
    });

    it('is cleared by a reset (RIS): it does not settle a repaint that is gone', async () => {
      const { term, clock, write, top } = setup();
      await write(lines(0, 200));
      term.scrollToLine(100);
      await write(REPRINT + lines(0, 20));
      expect(clock.pending()).toBe(1);
      await write('\x1bc');
      expect(clock.pending()).toBe(0);
      clock.advance(REPAINT_QUIET_MS);
      expect(top()).not.toBeUndefined();
    });

    it('is cleared when the tracker is disposed', async () => {
      const { term, clock, repaint, write } = setup();
      await write(lines(0, 200));
      term.scrollToLine(100);
      await write(REPRINT + lines(0, 20));
      expect(clock.pending()).toBe(1);
      repaint.dispose();
      expect(clock.pending()).toBe(0);
    });
  });
});
