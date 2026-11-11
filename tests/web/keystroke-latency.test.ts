import { describe, expect, it } from 'vitest';
import { cornerBadge, LatencyMeter, SETTLE_MS } from '../../src/web/src/state/keystroke-latency.js';

/** The Terminal tab's meter: a keystroke's echo arriving, and its whole redraw on screen (reported: "29 ms" felt laggy). */

describe('LatencyMeter: on screen, not only arrived', () => {
  it("the redraw is on screen at its last frame: Claude's later chunks and the drawing count", () => {
    const m = new LatencyMeter();
    m.keySent(0);
    expect(m.output(29)).toBe(29); // the first byte back
    m.rendered(40);
    m.output(55); // more of the same redraw
    m.rendered(70);
    expect(m.settle(70 + SETTLE_MS - 1)).toBeNull(); // not quiet long enough yet
    expect(m.settle(70 + SETTLE_MS)).toBe(70);
    expect(m.reading()).toEqual({ arrived: { median: 29, worst: 29 }, shown: { median: 70, worst: 70 } });
  });

  it('a new key closes the redraw before it; output with no frame drawn takes no on-screen sample', () => {
    const m = new LatencyMeter();
    m.keySent(0);
    m.output(20);
    m.rendered(35);
    m.keySent(50); // typed on: the first redraw closes at its last frame
    m.output(80);
    expect(m.settle(500)).toBeNull(); // nothing drawn for the second
    expect(m.reading()?.shown).toEqual({ median: 35, worst: 35 });
    expect(m.reading()?.arrived.median).toBe(25);
  });

  it('Claude streaming long after the key is no redraw of it; the worst is the 90th percentile, a stall shows', () => {
    const m = new LatencyMeter();
    m.keySent(0);
    m.output(10);
    m.output(3000); // streaming on: past the cap, the redraw is dropped
    m.rendered(3001);
    expect(m.settle(5000)).toBeNull();
    const n = new LatencyMeter();
    for (let i = 0; i < 9; i++) {
      n.keySent(i * 1000);
      n.output(i * 1000 + 20);
    }
    n.keySent(9000);
    n.output(9400); // one stall in ten
    expect(n.reading()?.arrived).toEqual({ median: 20, worst: 20 });
    n.keySent(10_000);
    n.output(10_500);
    expect(n.reading()?.arrived.worst).toBe(400);
  });
});

describe('the corner', () => {
  it('shows what you see (on screen) and, when much slower, the worst; the tooltip splits arrived from on screen', () => {
    const b = cornerBadge({ arrived: { median: 29, worst: 40 }, shown: { median: 60, worst: 210 } }, 'webgl')!;
    expect(b.text).toBe('⌁ 60 ms (210 ms)');
    expect(b.title).toContain('its echo arrived in 29 ms (40 ms)');
    expect(b.title).toContain('its redraw was on screen in 60 ms (210 ms)');
    expect(b.slow).toBe(false);
    expect(cornerBadge({ arrived: { median: 29, worst: 35 }, shown: null }, 'webgl')!.text).toBe('⌁ 29 ms');
    expect(cornerBadge({ arrived: { median: 20, worst: 20 }, shown: { median: 140, worst: 150 } }, 'webgl')!.slow).toBe(true);
    expect(cornerBadge(null, 'dom')).toMatchObject({ text: 'DOM', slow: true });
    expect(cornerBadge(null, 'webgl')).toBeNull();
  });
});
