import type { TerminalPerfWire } from '../../../core/api-types.js';
import type { KeySample } from './keystroke-latency.js';

/**
 * What the Terminal tab writes to work's debug log (reported: typing felt laggy with freezes, and a tooltip can't be
 * copied): each keystroke's echo and first frame, and every time this window froze (a long animation frame: the
 * page's main thread busy, so keys and drawing waited) with what ran in it. Pure: the tab feeds it and sends what
 * `take` returns every few seconds.
 */

/** Kept between sends at most; a window left open with nobody reading keeps no more. */
const MAX_KEYS = 200;
const MAX_STALLS = 100;

/** A frame the browser reports as long (Chromium's long-animation-frame, or longtask where that's missing). */
export interface FrameEntry {
  startTime: number;
  duration: number;
  /** long-animation-frame: the part that blocked input. */
  blockingDuration?: number;
  scripts?: { invoker?: string; sourceFunctionName?: string; sourceURL?: string; duration?: number }[];
}

export class TerminalPerfLog {
  private keys: KeySample[] = [];
  private stalls: TerminalPerfWire['stalls'] = [];

  key(s: KeySample | null): void {
    if (s && this.keys.length < MAX_KEYS)
      this.keys.push({ arrived: Math.round(s.arrived), shown: s.shown === null ? null : Math.round(s.shown) });
  }

  /** A long frame; `at` is the wall clock it started at. */
  stall(e: FrameEntry, at: number): void {
    if (this.stalls.length >= MAX_STALLS) return;
    this.stalls.push({
      at,
      ms: Math.round(e.duration),
      blocking: e.blockingDuration === undefined ? null : Math.round(e.blockingDuration),
      what: stallWhat(e),
    });
  }

  /** What to send, emptied; null when nothing happened. */
  take(base: Omit<TerminalPerfWire, 'keys' | 'stalls'>): TerminalPerfWire | null {
    if (!this.keys.length && !this.stalls.length) return null;
    const out = { ...base, keys: this.keys, stalls: this.stalls };
    this.keys = [];
    this.stalls = [];
    return out;
  }
}

/** The scripts that ran in a long frame, longest first: "onmessage PtyView.tsx 120ms". */
export function stallWhat(e: FrameEntry): string {
  const scripts = [...(e.scripts ?? [])].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 3);
  return scripts
    .map((s) => {
      const file = (s.sourceURL ?? '').split('/').pop()?.split('?')[0] ?? '';
      return [s.invoker, s.sourceFunctionName, file, s.duration !== undefined ? `${Math.round(s.duration)}ms` : '']
        .filter(Boolean)
        .join(' ')
        .slice(0, 160);
    })
    .join('; ');
}

/**
 * Report each long frame of this window: long-animation-frame where the browser has it (Chromium 123+, WebView2: with
 * the scripts that ran), else longtask. Returns the stop; a browser with neither (or none at all, in tests) reports none.
 */
export function observeLongFrames(on: (e: FrameEntry) => void): () => void {
  const PO = typeof PerformanceObserver === 'undefined' ? null : PerformanceObserver;
  const types = PO?.supportedEntryTypes ?? [];
  const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
  if (!PO || !type) return () => {};
  const obs = new PO((list) => {
    for (const e of list.getEntries()) on(e as unknown as FrameEntry);
  });
  obs.observe({ type, buffered: false });
  return () => obs.disconnect();
}
