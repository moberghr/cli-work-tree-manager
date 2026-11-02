// What an agent's plan limits look like (5-hour, weekly, spend) and how work shows them. Pure and agent-neutral: the SPA and the demo import it (each agent parses its own, e.g. agents/claude/rate-limits.ts).

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  /** ISO time the window resets; null when the agent didn't say. */
  resetsAt: string | null;
  /** Set when the reset time has passed since the reading: the percent is shown as 0. */
  reset?: true;
}

/** One account's last reading of an agent's plan limits (each config folder an agent runs with is an account). */
export interface UsageAccount {
  /** The account's name (the agent's own, e.g. a Claude account in config `claudeAccounts`; `default`), or the key a reading was kept under when it names none. */
  account: string;
  /** The account new sessions use (set on the one only). */
  isDefault?: true;
  at: string;
  windows: UsageWindow[];
}

/** An agent's readings, one per account: what the meter picks from. */
export interface AgentUsage {
  agent: string;
  name: string;
  accounts: UsageAccount[];
}

/** A window whose reset has passed since it was read starts over at 0. */
export function agedWindow(w: UsageWindow, now: number): UsageWindow {
  if (w.resetsAt === null) return w;
  const at = Date.parse(w.resetsAt);
  if (!Number.isFinite(at) || at > now) return w;
  return { ...w, usedPercent: 0, reset: true };
}

/** The window closest to its limit across every agent and account, for the top bar. Ties go to the one resetting later. */
export function meterWindow(
  agents: AgentUsage[],
  now: number,
): { agent: string; name: string; account: string; window: UsageWindow } | null {
  let best: { agent: string; name: string; account: string; window: UsageWindow } | null = null;
  const resetMs = (w: UsageWindow) => (w.resetsAt === null ? -Infinity : Date.parse(w.resetsAt) || -Infinity);
  for (const a of agents) {
    for (const acc of a.accounts) {
      for (const raw of acc.windows) {
        const window = agedWindow(raw, now);
        if (
          !best ||
          window.usedPercent > best.window.usedPercent ||
          (window.usedPercent === best.window.usedPercent && resetMs(window) > resetMs(best.window))
        ) {
          best = { agent: a.agent, name: a.name, account: acc.account, window };
        }
      }
    }
  }
  return best;
}

/** 273, 1.7k, 48k, 1.6M, 48M, 1.2B: the size of a token count, short enough for a panel row. */
export function formatTokens(n: number): string {
  const one = (v: number) => String(Math.round(v * 10) / 10);
  const x = Math.max(0, Math.round(n));
  if (x < 1e3) return String(x);
  if (x < 1e4) return `${one(x / 1e3)}k`;
  if (Math.round(x / 1e3) < 1e3) return `${Math.round(x / 1e3)}k`;
  if (x < 1e7) return `${one(x / 1e6)}M`;
  if (Math.round(x / 1e6) < 1e3) return `${Math.round(x / 1e6)}M`;
  return `${one(x / 1e9)}B`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "resets 15:10" within a day, "resets Mon 09:00" after that (local time); '' when there is no valid time. */
export function resetPhrase(resetsAt: string | null, now: number): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  return at - now < 24 * 3_600_000 ? `resets ${clock(d)}` : `resets ${WEEKDAYS[d.getDay()]} ${clock(d)}`;
}
