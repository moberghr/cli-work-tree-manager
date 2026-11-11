/**
 * How long a keystroke takes in the Terminal tab, in two parts:
 * - **arrived**: from sending it to the first output back (the echo) — browser → work web → PTY host → ConPTY →
 *   Claude and back;
 * - **on screen**: from sending it to the last frame drawn of the redraw it caused. Claude Code redraws its prompt
 *   in several chunks, and the terminal draws on the next animation frame, so what you see lands later than the
 *   first byte (reported: "29 ms", and typing still felt laggy).
 * Each as the median of the last few and the slowest of most of them (`worst`, the 90th percentile), so a stall
 * shows instead of hiding in a median. Pure (times passed in).
 */

/** An echo later than this isn't one (Claude was busy redrawing anyway). */
const MAX_SAMPLE_MS = 2_000;
/** A redraw is over once nothing came in and nothing was drawn for this long. */
export const SETTLE_MS = 100;
const KEEP = 20;

export interface LatencyStat {
  median: number;
  worst: number;
}

export interface LatencyReading {
  arrived: LatencyStat;
  /** Null until a redraw was seen drawn (or with no renderer events). */
  shown: LatencyStat | null;
}

export class LatencyMeter {
  private sentAt: number | null = null;
  private samples: number[] = [];
  private shownSamples: number[] = [];
  /** The redraw a key caused, from its first output until it settles. */
  private open: { sentAt: number; lastAt: number; drawnAt: number | null } | null = null;

  /** A key went out; only the first since the last echo counts (typing ahead isn't latency). */
  keySent(t: number): void {
    this.settle(t, true);
    if (this.sentAt === null) this.sentAt = t;
  }

  /** Output came in: the echo of the key sent, if one is waiting. Returns the sample, if it took one. */
  output(t: number): number | null {
    if (this.open) {
      this.open.lastAt = t; // more of the same redraw
      if (t - this.open.sentAt > MAX_SAMPLE_MS) this.open = null; // Claude streaming: not a keystroke's redraw
    }
    if (this.sentAt === null) return null;
    const ms = t - this.sentAt;
    const sent = this.sentAt;
    this.sentAt = null;
    if (ms < 0 || ms > MAX_SAMPLE_MS) return null;
    push(this.samples, ms);
    this.open = { sentAt: sent, lastAt: t, drawnAt: null };
    return ms;
  }

  /** The terminal drew a frame (xterm's onRender). */
  rendered(t: number): void {
    if (this.open) {
      this.open.drawnAt = t;
      this.open.lastAt = Math.max(this.open.lastAt, t);
    }
  }

  /**
   * Close the redraw once it went quiet (`SETTLE_MS` with nothing in or drawn) — or at once (`now`: a new key).
   * Returns its on-screen time when it took one.
   */
  settle(t: number, now = false): number | null {
    const o = this.open;
    if (!o || (!now && t - o.lastAt < SETTLE_MS)) return null;
    this.open = null;
    if (o.drawnAt === null) return null;
    const ms = o.drawnAt - o.sentAt;
    if (ms < 0 || ms > MAX_SAMPLE_MS) return null;
    push(this.shownSamples, ms);
    return ms;
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
  // What you see: the redraw on screen when known, else the echo's arrival.
  const seen = latency?.shown ?? latency?.arrived ?? null;
  const text = [seen && `⌁ ${ms(seen.median)}${seen.worst > seen.median * 1.5 ? ` (${ms(seen.worst)})` : ''}`, dom && 'DOM']
    .filter(Boolean)
    .join(' · ');
  const title = [
    latency &&
      `A keystroke, over the last 20 (median, and in brackets the slowest of most of them): its echo arrived in ${ms(latency.arrived.median)} (${ms(latency.arrived.worst)}) — browser → PTY host → ConPTY → Claude and back` +
        (latency.shown
          ? `; its redraw was on screen in ${ms(latency.shown.median)} (${ms(latency.shown.worst)}) — the rest of Claude's redraw and the drawing here.`
          : '.'),
    latency && route === 'direct' && 'Connected straight to the PTY host.',
    latency && route === 'relay' && 'Connected through work web (the PTY host gave no ticket: restart it with `work pty-host --restart`).',
    dom && 'Drawn without the GPU, which is slower while Claude works.',
    renderer === 'retrying' && 'The GPU renderer was lost; it is tried again by itself.',
    renderer === 'dom' && 'WebGL is unavailable here, or kept getting lost; reloading the page tries it again.',
  ]
    .filter(Boolean)
    .join(' ');
  return { text, title, slow: dom || (seen?.median ?? 0) > 100 };
}
