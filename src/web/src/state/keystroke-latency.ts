/**
 * How long a keystroke takes to come back on screen in the Terminal tab: from
 * sending it to the next output (the echo) — browser → work web → PTY host →
 * Claude and back. The median of the last few, so one slow redraw doesn't
 * swing it. Pure (times passed in).
 */

/** An echo later than this isn't one (Claude was busy redrawing anyway). */
const MAX_SAMPLE_MS = 2_000;
const KEEP = 20;

export class LatencyMeter {
  private sentAt: number | null = null;
  private samples: number[] = [];

  /** A key went out; only the first since the last echo counts (typing ahead isn't latency). */
  keySent(t: number): void {
    if (this.sentAt === null) this.sentAt = t;
  }

  /** Output came in: the echo of the key sent, if one is waiting. Returns the sample, if it took one. */
  output(t: number): number | null {
    if (this.sentAt === null) return null;
    const ms = t - this.sentAt;
    this.sentAt = null;
    if (ms < 0 || ms > MAX_SAMPLE_MS) return null;
    this.samples.push(ms);
    if (this.samples.length > KEEP) this.samples.shift();
    return ms;
  }

  /** The median of the samples kept, or null before there is one. */
  median(): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}
