import type { UsageWire } from '../../../core/api-types.js';
import { meterWindow, agedWindow, resetPhrase, type UsageWindow } from '../../../core/usage/usage.js';

// What the top bar's usage meter and its panel say (pure; UsageMeter.tsx draws it).

export type UsageLevel = 'none' | 'ok' | 'warn' | 'full';

export const levelOf = (pct: number): Exclude<UsageLevel, 'none'> => (pct >= 90 ? 'full' : pct >= 70 ? 'warn' : 'ok');

const shortAgent = (name: string) => (name === 'Claude Code' ? 'Claude' : name);

function shortWindow(w: UsageWindow): string {
  if (w.id === 'five_hour') return '5h';
  if (w.id === 'seven_day') return 'wk';
  if (w.id === 'spend_limit') return 'spend';
  return w.label.replace(/ limit$/, '');
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago". */
export function ageText(at: string, now: number): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return h < 48 ? 'yesterday' : `${Math.floor(h / 24)} days ago`;
}

/** A reading older than this is said to be old: only a running Claude refreshes it. */
export const STALE_MS = 6 * 3_600_000;
export const stale = (at: string, now: number): boolean => now - Date.parse(at) > STALE_MS;

/** The top bar's button: the window nearest its limit across every agent and account (`error`: why the last fetch failed). */
export function meterView(
  w: UsageWire | null,
  now: number,
  error: string | null = null,
): { text: string; level: UsageLevel; title: string } {
  if (!w && error) return { text: 'Usage', level: 'none', title: `Usage unavailable: ${error}` };
  const best = w ? meterWindow(w.agents, now) : null;
  if (!w || !best) {
    return {
      text: 'Usage',
      level: 'none',
      title: "No plan limits read yet: Claude Code's status line records them once a Claude session draws it. Click for token use.",
    };
  }
  const pct = Math.round(best.window.usedPercent);
  const at = w.agents.find((a) => a.agent === best.agent)?.accounts.find((a) => a.account === best.account)?.at;
  const parts = [`${best.window.label} ${pct}%`, resetPhrase(best.window.resetsAt, now), at ? `read ${ageText(at, now)}` : ''];
  return {
    text: `${shortAgent(best.name)} ${shortWindow(best.window)} ${pct}%`,
    level: levelOf(best.window.usedPercent),
    title: parts.filter(Boolean).join(' · '),
  };
}

export interface WindowRow {
  label: string;
  pct: number;
  level: Exclude<UsageLevel, 'none'>;
  reset: string;
}

/** One account's windows as the panel's rows (a window past its reset reads 0). */
export function windowRows(account: { windows: UsageWindow[] }, now: number): WindowRow[] {
  return account.windows.map((raw) => {
    const w = agedWindow(raw, now);
    return { label: w.label, pct: Math.round(w.usedPercent), level: levelOf(w.usedPercent), reset: resetPhrase(w.resetsAt, now) };
  });
}
