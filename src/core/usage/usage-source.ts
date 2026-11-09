import { knownAgents } from '../agents/index.js';
import { sessionTokens } from '../conversations/work-time-source.js';
import { dayKey } from '../conversations/work-time-view.js';
import { loadHistory } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { logSwallowed } from '../platform/best-effort.js';
import { lastConversationWriteMs } from '../sessions/session-activity.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import type { TokenTotals, UsageWire } from '../api-types.js';
import type { AgentUsageSource } from '../agents/types.js';
import { agedWindow } from './usage.js';

/**
 * What GET /api/usage and `work usage` answer: each agent's plan limits as
 * the last reading says (aged to now) and the tokens its sessions' transcripts
 * show, today and over the last 7 days. The I/O comes in through `deps`.
 */

const WEEK_DAYS = 7;
const TOP_SESSIONS = 5;

export interface UsageDeps {
  /** The agents that may have a usage part. */
  agents(): Array<{ id: string; name: string; usage?: Pick<AgentUsageSource, 'read'> }>;
  /** Sessions worth reading: live ones its agent wrote in lately. */
  sessions(now: number): WorktreeSession[];
  tokens(s: WorktreeSession, sinceDay: string): Promise<Record<string, Record<string, TokenTotals>>>;
  label(s: WorktreeSession): string;
}

const zero = (): TokenTotals => ({ input: 0, cached: 0, output: 0 });

function add(into: TokenTotals, t: TokenTotals): void {
  into.input += t.input;
  into.cached += t.cached;
  into.output += t.output;
}

/** The `week` days begin at: today and the 6 local days before it (by the calendar, not 24 h steps). */
export function weekStartDay(now: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - (WEEK_DAYS - 1));
  return dayKey(d.getTime());
}

export async function buildUsage(deps: UsageDeps, now = Date.now()): Promise<UsageWire> {
  const agents: UsageWire['agents'] = [];
  for (const a of deps.agents()) {
    if (!a.usage) continue;
    agents.push({
      agent: a.id,
      name: a.name,
      accounts: a.usage.read().map((acc) => ({ ...acc, windows: acc.windows.map((w) => agedWindow(w, now)) })),
    });
  }

  const today = dayKey(now);
  const since = weekStartDay(now);
  const todayTotal = zero();
  const weekTotal = zero();
  const models = new Map<string, { today: TokenTotals; week: TokenTotals }>();
  const perSession: Array<{ id: string; label: string; week: TokenTotals }> = [];
  for (const s of deps.sessions(now)) {
    let days: Record<string, Record<string, TokenTotals>>;
    try {
      days = await deps.tokens(s, since);
    } catch (e) {
      logSwallowed(`usage: tokens of ${sessionIdFor(s)}`, e);
      continue; // one unreadable session doesn't hide the rest
    }
    const week = zero();
    for (const [day, byModel] of Object.entries(days)) {
      if (day < since || day > today) continue;
      for (const [model, t] of Object.entries(byModel)) {
        const m = models.get(model) ?? { today: zero(), week: zero() };
        models.set(model, m);
        add(m.week, t);
        add(weekTotal, t);
        add(week, t);
        if (day === today) {
          add(m.today, t);
          add(todayTotal, t);
        }
      }
    }
    if (week.input + week.output > 0) perSession.push({ id: sessionIdFor(s), label: deps.label(s), week });
  }

  const size = (t: TokenTotals) => t.input + t.output;
  return {
    agents,
    tokens: {
      today: todayTotal,
      week: weekTotal,
      byModel: [...models].map(([model, v]) => ({ model, ...v })).sort((a, b) => size(b.week) - size(a.week)),
      topSessions: perSession.sort((a, b) => size(b.week) - size(a.week)).slice(0, TOP_SESSIONS),
    },
    at: new Date(now).toISOString(),
  };
}

/** The sessions whose tokens can fall in the week: not archived, and their agent wrote in the last 7 days. */
export function usageSessions(all: WorktreeSession[], lastWriteMs: (s: WorktreeSession) => number, now: number): WorktreeSession[] {
  return all.filter((s) => !s.archivedAt && lastWriteMs(s) >= now - WEEK_DAYS * 24 * 3_600_000);
}

export function realUsageDeps(): UsageDeps {
  return {
    agents: () => knownAgents(),
    sessions: (now) => usageSessions(loadHistory(), lastConversationWriteMs, now),
    tokens: sessionTokens,
    label: (s) => `${s.target} · ${s.title ? s.title : s.branch}`,
  };
}
