/**
 * How long a keystroke takes in the Terminal tab, in two parts:
 * - **arrived**: from sending it to the first output back (the echo) — browser → PTY host → ConPTY → Claude and back;
 * - **on screen**: from sending it to the first frame xterm drew after the echo arrived — what you see.
 * Each as the median of the last few and the slowest of most of them (`worst`, the 90th percentile), so a stall
 * shows instead of hiding in a median. Pure (times passed in).
 *
 * "On screen" was once the last frame before the output went quiet, to take in Claude Code's later chunks; but a
 * working Claude redraws its spinner every ~100 ms, so it never went quiet and the reading was the spinner's
 * (measured: the echo back in 6–18 ms, "on screen" 366 ms). The echo is the key's own character, so its first
 * frame is when you see it.
 */

/** An echo later than this isn't one (Claude was busy redrawing anyway). */
const MAX_SAMPLE_MS = 2_000;
const KEEP = 20;

export interface LatencyStat {
  median: number;
  worst: number;
}

export interface LatencyReading {
  arrived: LatencyStat;
  /** Null until an echo was seen drawn (or with no renderer events). */
  shown: LatencyStat | null;
}

/** One keystroke, measured: its echo's arrival and its first frame (null: no frame before the next key). */
export interface KeySample {
  arrived: number;
  shown: number | null;
}

export class LatencyMeter {
  private sentAt: number | null = null;
  private samples: number[] = [];
  private shownSamples: number[] = [];
  /** The echo that arrived and hasn't been drawn yet. */
  private open: { sentAt: number; arrived: number } | null = null;

  /**
   * A key went out; only the first since the last echo counts (typing ahead isn't latency).
   * Returns the key before it when its echo was never drawn.
   */
  keySent(t: number): KeySample | null {
    const o = this.open;
    this.open = null;
    if (this.sentAt === null) this.sentAt = t;
    return o ? { arrived: o.arrived, shown: null } : null;
  }

  /** Output came in: the echo of the key sent, if one is waiting. Returns its arrival time, if it took one. */
  output(t: number): number | null {
    if (this.sentAt === null) return null;
    const ms = t - this.sentAt;
    const sent = this.sentAt;
    this.sentAt = null;
    if (ms < 0 || ms > MAX_SAMPLE_MS) return null;
    push(this.samples, ms);
    this.open = { sentAt: sent, arrived: ms };
    return ms;
  }

  /** The terminal drew a frame (xterm's onRender): the first one after an echo is when it was on screen. */
  rendered(t: number): KeySample | null {
    const o = this.open;
    if (!o) return null;
    this.open = null;
    const ms = t - o.sentAt;
    if (ms < 0 || ms > MAX_SAMPLE_MS) return { arrived: o.arrived, shown: null };
    push(this.shownSamples, ms);
    return { arrived: o.arrived, shown: ms };
  }

  /** The median of the arrival samples kept, or null before there is one. */
  median(): number | null {
    return this.samples.length ? stat(this.samples).median : null;
  }

  /** Both parts, or null before a keystroke came back. */
  reading(): LatencyReading | null {
    if (!this.samples.length) return null;
    return { arrived: stat(this.samples), shown: this.shownSamples.length ? stat(this.shownSamples) : null };
  }
}

function push(list: number[], ms: number): void {
  list.push(ms);
  if (list.length > KEEP) list.shift();
}

function stat(list: number[]): LatencyStat {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, worst: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] };
}

/** The terminal's corner: how long a keystroke takes, and whether it draws without the GPU. Null: nothing to say. */
export function cornerBadge(
  latency: LatencyReading | null,
  renderer: 'webgl' | 'retrying' | 'dom',
  route: 'direct' | 'relay' | null = null,
): { text: string; title: string; slow: boolean } | null {
  const dom = renderer !== 'webgl';
  if (latency === null && !dom) return null;
  const ms = (n: number) => `${Math.round(n)} ms`;
  // What you see: the echo on screen when known, else its arrival.
  const seen = latency?.shown ?? latency?.arrived ?? null;
  const text = [seen && `⌁ ${ms(seen.median)}${seen.worst > seen.median * 1.5 ? ` (${ms(seen.worst)})` : ''}`, dom && 'DOM']
    .filter(Boolean)
    .join(' · ');
  const title = [
    latency &&
      `A keystroke, over the last 20 (median, and in brackets the slowest of most of them): its echo arrived in ${ms(latency.arrived.median)} (${ms(latency.arrived.worst)}) — browser → PTY host → ConPTY → Claude and back` +
        (latency.shown
          ? `; it was on screen in ${ms(latency.shown.median)} (${ms(latency.shown.worst)}) — the frame drawn after it.`
          : '.'),
    latency && route === 'direct' && 'Connected straight to the PTY host.',
    latency && route === 'relay' && 'Connected through work web (the PTY host gave no ticket: restart it with `work pty-host --restart`).',
    dom && 'Drawn without the GPU, which is slower while Claude works.',
    renderer === 'retrying' && 'The GPU renderer was lost; it is tried again by itself.',
    renderer === 'dom' && 'WebGL is unavailable here, or kept getting lost; reloading the page tries it again.',
    latency && 'Each keystroke and every freeze of this window is written to work’s debug log (terminal-perf).',
  ]
    .filter(Boolean)
    .join(' ');
  return { text, title, slow: dom || (seen?.median ?? 0) > 100 };
}
