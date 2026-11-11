import type { TerminalPerfWire } from '../api-types.js';

/**
 * The Terminal tab's measurements for work's debug log (`POST /api/terminal-perf`): read strictly — anything off its
 * shape is refused, numbers clamped, text cut — and put into one line someone can read: keystroke times as
 * median / 90th percentile / max, then each freeze of the window.
 */

const MAX_KEYS = 200;
const MAX_STALLS = 100;

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1e13;

export function cleanPerfReport(x: unknown): TerminalPerfWire | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  if (typeof r.sessionId !== 'string' || !r.sessionId || r.sessionId.length > 200) return null;
  if (r.route !== 'direct' && r.route !== 'relay' && r.route !== null) return null;
  if (r.renderer !== 'webgl' && r.renderer !== 'retrying' && r.renderer !== 'dom') return null;
  if (!Array.isArray(r.keys) || !Array.isArray(r.stalls)) return null;
  const keys: TerminalPerfWire['keys'] = [];
  for (const k of r.keys.slice(0, MAX_KEYS)) {
    const o = k as Record<string, unknown> | null;
    if (!o || !num(o.arrived) || !(o.shown === null || num(o.shown))) return null;
    keys.push({ arrived: Math.round(o.arrived), shown: o.shown === null ? null : Math.round(o.shown) });
  }
  const stalls: TerminalPerfWire['stalls'] = [];
  for (const s of r.stalls.slice(0, MAX_STALLS)) {
    const o = s as Record<string, unknown> | null;
    if (!o || !num(o.at) || !num(o.ms) || !(o.blocking === null || num(o.blocking)) || typeof o.what !== 'string') return null;
    stalls.push({
      at: o.at,
      ms: Math.round(o.ms),
      blocking: o.blocking === null ? null : Math.round(o.blocking),
      what: o.what.slice(0, 500),
    });
  }
  return { sessionId: r.sessionId, route: r.route, renderer: r.renderer, keys, stalls };
}

/** "12 / 30 / 41 ms" — median / 90th percentile / max; "–" with none. */
function spread(list: number[]): string {
  if (!list.length) return '–';
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return `${median} / ${s[Math.ceil(s.length * 0.9) - 1]} / ${s[s.length - 1]} ms`;
}

/** One line for the debug log. */
export function perfLine(r: TerminalPerfWire): string {
  const shown = r.keys.map((k) => k.shown).filter((n): n is number => n !== null);
  const parts = [
    `terminal-perf ${r.sessionId} (${r.route ?? 'unknown'}, ${r.renderer})`,
    `${r.keys.length} keys: echo ${spread(r.keys.map((k) => k.arrived))}, on screen ${spread(shown)} (median / p90 / max)`,
    `${r.stalls.length} freezes${r.stalls.length ? ': ' + r.stalls.map((s) => `${new Date(s.at).toISOString().slice(11, 23)} ${s.ms}ms${s.blocking !== null ? ` (blocking ${s.blocking})` : ''}${s.what ? ` [${s.what}]` : ''}`).join(' | ') : ''}`,
  ];
  return parts.join('; ');
}
