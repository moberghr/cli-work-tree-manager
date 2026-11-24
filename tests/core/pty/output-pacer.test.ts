import { describe, it, expect } from 'vitest';
import {
  CATCH_UP_MIN_MS,
  COALESCE_MS,
  FRAME_HOLD_MAX_CHARS,
  FRAME_HOLD_MS,
  MAX_FRAME_CHARS,
  OutputPacer,
  PAUSE_TIMEOUT_MS,
  type PacedClient,
  type PacerTimers,
} from '../../../src/core/pty/output-pacer.js';
import { HIGH_WATERMARK, LOW_WATERMARK } from '../../../src/core/pty/flow-control.js';
import { BSU, ESU } from '../../../src/core/pty/sync-output.js';

/** Timers the test moves by hand. */
class Clock implements PacerTimers {
  t = 0;
  private seq = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.due.set(id, { at: this.t + ms, fn });
    return id;
  };
  clear = (h: unknown) => {
    this.due.delete(h as number);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.due.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
  get pending() {
    return this.due.size;
  }
}

class Client implements PacedClient {
  frames: Array<[string, number]> = [];
  resyncs = 0;
  /** What each catch-up was given: the offset it was sent output up to, or null (a screen wanted). */
  froms: Array<number | null> = [];
  /** Whether the registry would continue it from the tail when it may (else it always sends a screen). */
  continues = false;
  constructor(readonly metered = true) {}
  send = (frame: string, end: number) => {
    this.frames.push([frame, end]);
  };
  resync = (from: number | null) => {
    this.resyncs++;
    this.froms.push(from);
    return this.continues && from !== null;
  };
  get text() {
    return this.frames.map(([f]) => f).join('');
  }
  get chars() {
    return this.text.length;
  }
}

function setup(opts: { flow?: boolean } = {}) {
  const clock = new Clock();
  const flow = { paused: false, pauses: 0, resumes: 0, pause: () => {}, resume: () => {} };
  flow.pause = () => {
    flow.paused = true;
    flow.pauses++;
  };
  flow.resume = () => {
    flow.paused = false;
    flow.resumes++;
  };
  let holder: string | null = null;
  const pacer = new OutputPacer<string>({ flow: opts.flow === false ? null : flow, holder: () => holder, timers: clock });
  return {
    clock,
    flow,
    pacer,
    hold: (k: string | null) => {
      holder = k;
    },
  };
}

/** `n` characters of output, as chunks of at most `size`, each after a quiet moment (so each is a frame of its own). */
function flood(s: ReturnType<typeof setup>, n: number, size = 10_000) {
  for (let left = n; left > 0; left -= size) {
    s.pacer.output('x'.repeat(Math.min(size, left)));
    s.clock.advance(COALESCE_MS);
  }
}

describe('coalescing', () => {
  it('sends the first output of a quiet moment at once', () => {
    const s = setup();
    const a = new Client(false);
    s.pacer.add('a', a);
    s.pacer.output('k');
    expect(a.frames).toEqual([['k', 1]]);
  });

  it('sends what follows within COALESCE_MS as one frame, then the next quiet output at once again', () => {
    const s = setup();
    const a = new Client(false);
    s.pacer.add('a', a);
    s.pacer.output('1');
    s.clock.advance(2);
    s.pacer.output('2');
    s.pacer.output('3');
    expect(a.frames).toEqual([['1', 1]]);
    s.clock.advance(COALESCE_MS);
    expect(a.frames).toEqual([
      ['1', 1],
      ['23', 3],
    ]);
    // That window carried output, so another is open: more within it waits for it to close too.
    s.pacer.output('4');
    expect(a.frames).toHaveLength(2);
    s.clock.advance(COALESCE_MS);
    expect(a.frames.at(-1)).toEqual(['4', 4]);
    // A window with nothing in it: quiet again, so the next output goes at once.
    s.clock.advance(COALESCE_MS);
    expect(s.clock.pending).toBe(0);
    s.pacer.output('5');
    expect(a.frames.at(-1)).toEqual(['5', 5]);
  });

  it('bounds a frame at MAX_FRAME_CHARS; a single bigger chunk goes alone', () => {
    const s = setup();
    const a = new Client(false);
    s.pacer.add('a', a);
    s.pacer.output('a'); // opens the window
    const half = 'b'.repeat(MAX_FRAME_CHARS / 2);
    s.pacer.output(half);
    s.pacer.output(half);
    s.pacer.output('c'); // would pass the bound: what was pending goes first
    expect(a.frames.map(([f]) => f.length)).toEqual([1, MAX_FRAME_CHARS]);
    s.pacer.output('d'.repeat(MAX_FRAME_CHARS + 10)); // bigger than the bound on its own
    s.clock.advance(COALESCE_MS);
    expect(a.frames.map(([f]) => f.length)).toEqual([1, MAX_FRAME_CHARS, 1, MAX_FRAME_CHARS + 10]);
    expect(a.text).toBe('a' + half + half + 'c' + 'd'.repeat(MAX_FRAME_CHARS + 10));
  });

  it("flush() sends what is pending now (the PTY ended), and a client that joins isn't sent what came before it", () => {
    const s = setup();
    const a = new Client(false);
    s.pacer.add('a', a);
    s.pacer.output('1');
    s.pacer.output('2');
    const b = new Client(false);
    s.pacer.add('b', b); // '2' went to a first: b's snapshot has it
    expect(a.text).toBe('12');
    s.pacer.output('3');
    s.pacer.flush();
    expect(a.text).toBe('123');
    expect(b.text).toBe('3');
  });
});

describe('offsets', () => {
  it('a frame cut at MAX_FRAME_CHARS ends where the chunk that did not fit starts (a catch-up continues from there)', () => {
    const s = setup();
    const a = new Client(false);
    s.pacer.add('a', a);
    s.pacer.output('k'); // opens a window
    s.pacer.output('x'.repeat(MAX_FRAME_CHARS - 10)); // pending
    s.pacer.output('y'.repeat(20)); // does not fit: what is pending goes first
    s.clock.advance(COALESCE_MS);
    let at = 0;
    for (const [frame, end] of a.frames) expect(end).toBe((at += frame.length));
    expect(at).toBe(s.pacer.offset);
  });

  it('end each frame at the characters of output since the start, for every client, through a change of process', () => {
    const s = setup();
    s.pacer.output('before'); // nobody attached: still counted
    s.clock.advance(COALESCE_MS);
    const a = new Client(false);
    s.pacer.add('a', a);
    s.pacer.output('ab');
    s.pacer.output('cde');
    s.clock.advance(COALESCE_MS);
    s.pacer.setFlow(null); // a restart: the count goes on
    s.clock.advance(COALESCE_MS);
    s.pacer.output('é😀'); // UTF-16 code units: 1 + 2
    const ends = a.frames.map(([, end]) => end);
    expect(ends).toEqual([8, 11, 14]);
    expect(s.pacer.offset).toBe(14);
    expect([...ends].sort((x, y) => x - y)).toEqual(ends);
  });
});

describe('the holder pauses the PTY', () => {
  it('above HIGH_WATERMARK, and resumes it only below LOW_WATERMARK', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.hold('a');
    flood(s, HIGH_WATERMARK);
    expect(s.flow.paused).toBe(false); // at HIGH, not above it
    flood(s, 1);
    expect(s.flow.paused).toBe(true);
    expect(s.pacer.isPaused).toBe(true);
    s.pacer.ack('a', HIGH_WATERMARK + 1 - LOW_WATERMARK); // exactly LOW left: still waiting
    expect(s.flow.paused).toBe(true);
    s.pacer.ack('a', 1);
    expect(s.flow.paused).toBe(false);
    expect(s.flow).toMatchObject({ pauses: 1, resumes: 1 });
    expect(s.pacer.live('a')).toBe(true);
    expect(a.chars).toBe(HIGH_WATERMARK + 1);
  });

  it('only for PAUSE_TIMEOUT_MS: then the PTY goes on, the holder is behind, and it pauses nothing until it is used', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.hold('a');
    flood(s, HIGH_WATERMARK + 1); // paused as its last chunk went, COALESCE_MS ago
    s.clock.advance(PAUSE_TIMEOUT_MS - COALESCE_MS - 1);
    expect(s.flow.paused).toBe(true);
    s.pacer.output('o');
    s.pacer.output('pending'); // in an open window when the time runs out: sent to it first
    expect(a.text.endsWith('pending')).toBe(false);
    s.clock.advance(1);
    expect(s.flow.paused).toBe(false);
    expect(a.text.endsWith('pending')).toBe(true);
    expect(s.pacer.live('a')).toBe(false);
    const before = a.chars;
    flood(s, 50_000);
    expect(a.chars).toBe(before); // behind: no live output
    // It catches up: a fresh screen, then live output — and, not used since, it doesn't pause the PTY again.
    s.pacer.ack('a', a.chars);
    expect(a.resyncs).toBe(1);
    expect(s.pacer.live('a')).toBe(true);
    flood(s, HIGH_WATERMARK + 10_000);
    expect(s.flow.pauses).toBe(1);
    expect(s.pacer.live('a')).toBe(false);
    // Used (typed in): it may hold the PTY again.
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    s.pacer.used('a');
    flood(s, HIGH_WATERMARK + 1);
    expect(s.flow.pauses).toBe(2);
  });

  it('is released when the holder disconnects, when another client holds the PTY, and when the process changes or ends', () => {
    const s = setup();
    const a = new Client();
    const b = new Client();
    s.pacer.add('a', a);
    s.pacer.add('b', b);
    s.hold('a');
    flood(s, HIGH_WATERMARK + 1);
    expect(s.flow.paused).toBe(true);
    s.hold('b');
    s.pacer.remove('a');
    expect(s.flow.paused).toBe(false);

    // b holds it now: it fell behind meanwhile; it catches up, then a flood.
    s.pacer.ack('b', b.chars);
    s.clock.advance(CATCH_UP_MIN_MS);
    expect(s.pacer.live('b')).toBe(true);
    flood(s, HIGH_WATERMARK + 1);
    expect(s.flow.paused).toBe(true);
    s.pacer.setFlow(null); // the process exited
    expect(s.flow.paused).toBe(false);
    flood(s, HIGH_WATERMARK + 1);
    expect(s.flow.pauses).toBe(2); // no process to pause: b falls behind instead
    expect(s.pacer.live('b')).toBe(false);

    const t = setup();
    const c = new Client();
    t.pacer.add('c', c);
    t.hold('c');
    flood(t, HIGH_WATERMARK + 1);
    expect(t.flow.paused).toBe(true);
    t.pacer.dispose(); // killed
    expect(t.flow.paused).toBe(false);
    t.clock.advance(PAUSE_TIMEOUT_MS * 2);
    expect(t.clock.pending).toBe(0);
  });

  it("is released when the holder hands the PTY to another (a new leader) that isn't behind it", () => {
    const s = setup();
    const a = new Client();
    const b = new Client(false);
    s.pacer.add('a', a);
    s.pacer.add('b', b);
    s.hold('a');
    flood(s, HIGH_WATERMARK + 1);
    expect(s.flow.paused).toBe(true);
    s.hold('b');
    s.pacer.used('b'); // b typed: the registry's leader is b
    expect(s.flow.paused).toBe(false);
    // a, no longer the holder and too far behind, gets no more; b (unmetered) gets everything.
    flood(s, 10);
    expect(s.pacer.live('a')).toBe(false);
    expect(b.chars).toBe(HIGH_WATERMARK + 11);
  });

  it('without a way to pause (Windows), the holder falls behind instead', () => {
    const s = setup({ flow: false });
    const a = new Client();
    s.pacer.add('a', a);
    s.hold('a');
    flood(s, HIGH_WATERMARK + 1);
    expect(s.pacer.isPaused).toBe(false);
    expect(s.pacer.live('a')).toBe(false);
  });
});

describe('a client that is not the holder', () => {
  it('above HIGH_WATERMARK is behind: no live output, then a fresh screen once its acks bring it under LOW_WATERMARK', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    flood(s, HIGH_WATERMARK + 1);
    expect(s.pacer.live('a')).toBe(false);
    expect(s.flow.pauses).toBe(0); // nobody waits for a view that isn't the holder
    const sent = a.chars;
    flood(s, 30_000);
    expect(a.chars).toBe(sent);
    s.pacer.ack('a', sent - LOW_WATERMARK); // not under LOW yet
    expect(a.resyncs).toBe(0);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', 1);
    expect(a.resyncs).toBe(1);
    expect(s.pacer.live('a')).toBe(true);
    s.pacer.output('live');
    expect(a.text.endsWith('live')).toBe(true);
  });

  it('is sent a fresh screen at most every CATCH_UP_MIN_MS, and what was pending goes to the others first', () => {
    const s = setup();
    const a = new Client();
    const other = new Client(false);
    s.pacer.add('a', a);
    s.pacer.add('o', other);
    flood(s, HIGH_WATERMARK + 1);
    s.pacer.ack('a', a.chars); // caught up, but it got a screen (its attach) just now
    expect(a.resyncs).toBe(0);
    s.pacer.output('x1'); // opens a window
    s.pacer.output('x2'); // pending
    s.clock.advance(CATCH_UP_MIN_MS - s.clock.t - 1); // windows came and went; the catch-up is still waiting
    expect(a.resyncs).toBe(0);
    s.pacer.output('y1');
    s.pacer.output('y2'); // pending when the catch-up runs
    s.clock.advance(1);
    expect(a.resyncs).toBe(1);
    expect(other.text.endsWith('y1y2')).toBe(true); // went to the other before a was resynced…
    expect(a.text.includes('y')).toBe(false); // …and not to a: its screen has it
  });

  it('an unmetered client (an old one) is sent everything and never holds the PTY back', () => {
    const s = setup();
    const old = new Client(false);
    const metered = new Client();
    s.pacer.add('old', old);
    s.pacer.add('m', metered);
    s.hold('old');
    flood(s, HIGH_WATERMARK * 3);
    expect(old.chars).toBe(HIGH_WATERMARK * 3);
    expect(s.flow.pauses).toBe(0);
    expect(s.pacer.live('old')).toBe(true);
    expect(s.pacer.live('m')).toBe(false);
    s.pacer.ack('old', 10); // its acks, if any, are ignored
    expect(s.pacer.stats('old')).toMatchObject({ acked: 0 });
  });

  it('an ack never counts for more than was sent', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.pacer.output('abc');
    s.pacer.ack('a', 1000);
    expect(s.pacer.stats('a')).toEqual({ sent: 3, acked: 3, unacked: 0, behind: false });
  });

  it('end(): the last output goes to the live clients, the pause is released, and every client behind is sent the final screen at once', () => {
    const s = setup();
    const h = new Client();
    const a = new Client(); // behind, its acks far off
    const c = new Client(); // behind, caught up, its catch-up waiting for CATCH_UP_MIN_MS
    s.pacer.add('h', h);
    s.pacer.add('a', a);
    s.pacer.add('c', c);
    s.hold('h');
    flood(s, HIGH_WATERMARK + 1);
    expect(s.flow.paused).toBe(true);
    expect([s.pacer.live('a'), s.pacer.live('c')]).toEqual([false, false]);
    s.pacer.ack('c', c.chars);
    expect(c.resyncs).toBe(0);
    s.pacer.output('t1');
    s.pacer.output('t2'); // pending as it ends
    const seen: boolean[] = [];
    a.resync = () => {
      a.resyncs++;
      seen.push(h.text.endsWith('t2')); // the last output went out before the final screen
      return false;
    };
    expect(s.clock.t).toBeLessThan(CATCH_UP_MIN_MS);
    s.pacer.end();
    expect(h.text.endsWith('t2')).toBe(true);
    expect(seen).toEqual([true]);
    expect([a.resyncs, c.resyncs, h.resyncs]).toEqual([1, 1, 0]);
    expect(a.text.includes('t')).toBe(false); // its screen has it
    expect(s.flow.paused).toBe(false);
    s.clock.advance(COALESCE_MS); // the window 't1' opened closes, empty
    expect(s.clock.pending).toBe(0); // c's catch-up timer went with it
    s.clock.advance(CATCH_UP_MIN_MS);
    expect([a.resyncs, c.resyncs]).toEqual([1, 1]);
  });

  it('a client removed while waiting for its catch-up leaves no timer', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    flood(s, HIGH_WATERMARK + 1);
    s.clock.advance(COALESCE_MS);
    s.pacer.ack('a', a.chars);
    s.pacer.remove('a');
    s.clock.advance(CATCH_UP_MIN_MS);
    expect(a.resyncs).toBe(0);
    expect(s.clock.pending).toBe(0);
  });
});

describe('a client caught up from the tail (terminal-rendering.md, "Flow control and coalescing")', () => {
  /** `a` (metered, never the holder) behind after a flood, with an unmetered `o` that is sent everything. */
  function behind() {
    const s = setup();
    const a = new Client();
    a.continues = true;
    const o = new Client(false);
    s.pacer.add('a', a);
    s.pacer.add('o', o);
    flood(s, HIGH_WATERMARK + 1);
    expect(s.pacer.live('a')).toBe(false);
    return { s, a, o };
  }

  it('is given the offset it was sent output up to: the end of its last frame, where its screen will stand', () => {
    const { s, a } = behind();
    const sentTo = a.frames.at(-1)![1];
    expect(sentTo).toBe(a.chars);
    flood(s, 30_000); // missed
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    expect(a.froms).toEqual([sentTo]);
    expect(s.pacer.tail.since(sentTo)).toHaveLength(30_000); // all still in the tail: what the registry sends it
    expect(s.pacer.live('a')).toBe(true);
    s.pacer.output('live');
    expect(a.frames.at(-1)).toEqual(['live', s.pacer.offset]); // live again, right after what it missed
  });

  it('the holder that timed out is given the offset of what was pending when it did (sent to it first)', () => {
    const s = setup();
    const a = new Client();
    a.continues = true;
    s.pacer.add('a', a);
    s.hold('a');
    flood(s, HIGH_WATERMARK + 1);
    s.pacer.output('pending');
    s.clock.advance(PAUSE_TIMEOUT_MS);
    expect(s.pacer.live('a')).toBe(false);
    const sentTo = s.pacer.offset;
    expect(a.text.endsWith('pending')).toBe(true);
    flood(s, 10_000);
    s.pacer.ack('a', a.chars);
    expect(a.froms).toEqual([sentTo]);
  });

  it('behind again before it drew past what it missed: its next catch-up is a screen (null), then the tail again', () => {
    const { s, a } = behind();
    flood(s, 30_000);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    expect(a.froms).toHaveLength(1);
    expect(a.froms[0]).not.toBeNull();
    // Still drawing what it missed (it acks nothing sent since): behind again.
    flood(s, HIGH_WATERMARK + 1);
    expect(s.pacer.live('a')).toBe(false);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    expect(a.froms[1]).toBeNull(); // a screen: it skips to where the output stands
    // After a screen, a client behind again is continued from the tail as before.
    flood(s, HIGH_WATERMARK + 1);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    expect(a.froms[2]).toBe(a.frames.at(-1)![1]);
  });

  it('behind again after it drew past what it missed (it acked output sent since): the tail again', () => {
    const { s, a } = behind();
    flood(s, 30_000);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    const sentAtCatchUp = a.chars;
    flood(s, 20_000);
    s.pacer.ack('a', 10_000); // drew what it missed and 10 000 sent since
    expect(s.pacer.stats('a')!.acked).toBeGreaterThan(sentAtCatchUp);
    flood(s, HIGH_WATERMARK + 1);
    expect(s.pacer.live('a')).toBe(false);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    expect(a.froms[1]).toBe(a.frames.at(-1)![1]);
  });

  it('what it missed is not counted: its unacked count starts where it was (as after a screen)', () => {
    const { s, a } = behind();
    flood(s, 50_000);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    expect(s.pacer.stats('a')).toMatchObject({ unacked: 0, behind: false });
  });

  it('a registry that sends a screen instead (false) leaves the next catch-up free to use the tail', () => {
    const { s, a } = behind();
    a.continues = false;
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    flood(s, HIGH_WATERMARK + 1); // behind again at once: no tail catch-up to blame
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.ack('a', a.chars);
    expect(a.froms[1]).not.toBeNull();
  });
});

describe('synchronized frames (DEC 2026)', () => {
  /** Each frame's end is the characters sent so far: offsets only grow, and count everything. */
  const expectOffsets = (c: Client) => {
    let total = 0;
    for (const [frame, end] of c.frames) {
      total += frame.length;
      expect(end).toBe(total);
    }
  };

  it('holds a frame whole across chunks and coalescing windows, and sends it as one message when it ends', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.pacer.output('before');
    s.pacer.output(`${BSU}part1`);
    s.pacer.output('part2');
    s.clock.advance(COALESCE_MS * 3);
    s.pacer.output('pa');
    expect(s.pacer.inFrame).toBe(true);
    expect(a.frames.map(([f]) => f)).toEqual(['before']);
    s.pacer.output(`rt3${ESU}after`);
    expect(a.frames.map(([f]) => f)).toEqual(['before', `${BSU}part1part2part3${ESU}`, 'after']);
    expect(s.pacer.inFrame).toBe(false);
    expectOffsets(a);
  });

  it('follows a set and a reset cut between chunks: the frame body goes in one message', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.pacer.output('x\x1b[?20');
    s.pacer.output('26hframe\x1b[?202');
    s.clock.advance(COALESCE_MS * 2);
    s.pacer.output('6l');
    expect(a.frames.map(([f]) => f)).toEqual(['x\x1b[?20', `26hframe${ESU}`]);
    expectOffsets(a);
  });

  it('a second set inside a frame changes nothing, a reset with no frame open is plain output', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.pacer.output(`${ESU}a`);
    s.clock.advance(COALESCE_MS);
    s.pacer.output(`${BSU}b${BSU}c`);
    s.clock.advance(COALESCE_MS);
    s.pacer.output(ESU);
    expect(a.frames.map(([f]) => f)).toEqual([`${ESU}a`, `${BSU}b${BSU}c${ESU}`]);
  });

  it('time cap: a frame not ended within FRAME_HOLD_MS goes out then, and the rest of it flows as any output does', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.pacer.output(`${BSU}a`);
    s.clock.advance(FRAME_HOLD_MS - 1);
    expect(a.chars).toBe(0);
    s.clock.advance(1);
    expect(a.text).toBe(`${BSU}a`);
    s.pacer.output('b'); // the same frame, no longer held: coalesced
    s.pacer.output('c');
    expect(a.text).toBe(`${BSU}ab`);
    s.pacer.output(ESU);
    s.clock.advance(COALESCE_MS);
    expect(a.text).toBe(`${BSU}abc${ESU}`);
    s.pacer.output(`${BSU}next`); // the next frame is held again
    expect(s.pacer.inFrame).toBe(true);
    expectOffsets(a);
  });

  it('size cap: a frame held past FRAME_HOLD_MAX_CHARS goes out at once', () => {
    const s = setup();
    const a = new Client(false);
    s.pacer.add('a', a);
    s.pacer.output(BSU);
    s.pacer.output('x'.repeat(FRAME_HOLD_MAX_CHARS - BSU.length));
    expect(a.chars).toBe(0); // at the cap, not past it
    s.pacer.output('y');
    expect(a.chars).toBe(FRAME_HOLD_MAX_CHARS + 1);
    expect(s.pacer.inFrame).toBe(false);
    expectOffsets(a);
  });

  it('pauses the PTY for its holder only at a frame end, never mid-frame', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.hold('a');
    flood(s, HIGH_WATERMARK);
    s.pacer.output(`${BSU}${'x'.repeat(100)}`);
    s.clock.advance(COALESCE_MS);
    s.pacer.output('y'.repeat(100));
    expect(s.flow.paused).toBe(false); // over HIGH_WATERMARK by what is held, but the rest of the frame must be read
    s.pacer.output(ESU);
    expect(s.flow.paused).toBe(true);
    expect(a.text.endsWith(`${'y'.repeat(100)}${ESU}`)).toBe(true);
  });

  it('a catch-up due mid-frame waits for the frame end: the screen it is sent is never drawn halfway', () => {
    const s = setup();
    const a = new Client();
    const other = new Client(false);
    s.pacer.add('a', a);
    s.pacer.add('o', other);
    flood(s, HIGH_WATERMARK + 1);
    expect(s.pacer.live('a')).toBe(false);
    s.clock.advance(CATCH_UP_MIN_MS);
    s.pacer.output(`${BSU}half`);
    s.pacer.ack('a', a.chars); // caught up, mid-frame
    expect(a.resyncs).toBe(0);
    s.pacer.output(`rest${ESU}`);
    expect(a.resyncs).toBe(1);
    expect(other.text.endsWith(`${BSU}halfrest${ESU}`)).toBe(true); // to the others first…
    expect(a.text.includes('half')).toBe(false); // …and not to a: its screen, taken now, has all of it
    expect(s.pacer.live('a')).toBe(true);
  });

  it('whenNoFrame: at once between frames; right after the frame went out mid-frame; gone when the entry is disposed', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    const calls: Array<[boolean, number]> = [];
    s.pacer.whenNoFrame((gone) => calls.push([gone, a.chars]));
    s.pacer.output(`${BSU}frame`);
    s.pacer.whenNoFrame((gone) => calls.push([gone, a.chars]));
    expect(calls).toEqual([[false, 0]]);
    s.pacer.output(ESU);
    expect(calls).toEqual([
      [false, 0],
      [false, BSU.length + 5 + ESU.length],
    ]);
    s.pacer.output(`${BSU}again`);
    s.pacer.whenNoFrame((gone) => calls.push([gone, -1]));
    s.pacer.dispose();
    expect(calls.at(-1)).toEqual([true, -1]);
    expect(s.clock.pending).toBe(0);
  });

  it('a client joining mid-frame is sent none of it: what is held goes to the others first, the rest to everyone', () => {
    const s = setup();
    const a = new Client();
    const b = new Client();
    s.pacer.add('a', a);
    s.pacer.output(`${BSU}held`);
    s.pacer.add('b', b);
    expect(a.text).toBe(`${BSU}held`);
    s.pacer.output(`rest${ESU}`);
    expect(b.text).toBe(`rest${ESU}`);
    expect(b.frames[0]![1]).toBe(a.chars); // the same offset for both
  });

  it('the process ending or changing mid-frame sends what is held; a restart forgets the open frame', () => {
    const s = setup();
    const a = new Client();
    s.pacer.add('a', a);
    s.pacer.output(`${BSU}last words`);
    s.pacer.end();
    expect(a.text).toBe(`${BSU}last words`);
    expect(s.clock.pending).toBe(0);

    const r = setup();
    const c = new Client();
    r.pacer.add('c', c);
    r.pacer.output(`${BSU}old process`);
    r.pacer.setFlow({ pause() {}, resume() {} });
    expect(c.text).toBe(`${BSU}old process`);
    r.clock.advance(COALESCE_MS);
    r.pacer.output('new process'); // not part of a frame: sent at once
    expect(c.text.endsWith('new process')).toBe(true);
    r.pacer.output(BSU);
    r.pacer.flush(); // the host stopping
    expect(c.text.endsWith(BSU)).toBe(true);
    expectOffsets(c);
  });
});
