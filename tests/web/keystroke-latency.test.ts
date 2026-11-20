import { describe, expect, it } from 'vitest';
import { cornerBadge, LatencyMeter } from '../../src/web/src/state/keystroke-latency.js';

/** The Terminal tab's meter: a keystroke's echo arriving, and its whole redraw on screen (reported: "29 ms" felt laggy). */

describe('LatencyMeter: on screen is the first frame after the echo', () => {
  it("a working Claude's spinner keeps redrawing: on screen is still the key's own frame, not the last before quiet", () => {
    // Measured: the echo back in 6-18 ms, then a spinner redraw every ~100 ms; the old "last frame before quiet" read 366 ms.
    const m = new LatencyMeter();
    m.keySent(0);
    expect(m.output(12)).toBe(12); // the echo
    expect(m.rendered(28)).toEqual({ arrived: 12, shown: 28 }); // its frame
    m.output(110); // the spinner
    expect(m.rendered(120)).toBeNull(); // not a key's
    m.output(210);
    m.rendered(220);
    expect(m.reading()).toEqual({ arrived: { median: 12, worst: 12 }, shown: { median: 28, worst: 28 } });
  });

  it('a key typed before its echo was drawn says so (shown null) and starts its own', () => {
    const m = new LatencyMeter();
    m.keySent(0);
    m.output(20);
    expect(m.keySent(50)).toEqual({ arrived: 20, shown: null }); // never drawn before the next key
    m.output(80);
    expect(m.rendered(95)).toEqual({ arrived: 30, shown: 45 });
    expect(m.reading()?.shown).toEqual({ median: 45, worst: 45 });
    expect(m.reading()?.arrived.median).toBe(25);
  });

  it('a frame long after the key is a stall, not a sample; the worst is the 90th percentile, a stall shows', () => {
    const m = new LatencyMeter();
    m.keySent(0);
    m.output(10);
    expect(m.rendered(3000)).toEqual({ arrived: 10, shown: null });
    expect(m.reading()?.shown).toBeNull();
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
    expect(b.title).toContain('it was on screen in 60 ms (210 ms)');
    expect(b.slow).toBe(false);
    expect(cornerBadge({ arrived: { median: 29, worst: 35 }, shown: null }, 'webgl')!.text).toBe('⌁ 29 ms');
    expect(cornerBadge({ arrived: { median: 20, worst: 20 }, shown: { median: 140, worst: 150 } }, 'webgl')!.slow).toBe(true);
    expect(cornerBadge(null, 'dom')).toMatchObject({ text: 'DOM', slow: true });
    expect(cornerBadge(null, 'webgl')).toBeNull();
  });
});
