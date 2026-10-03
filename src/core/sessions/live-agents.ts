import type { SessionClaudes } from '../api-types.js';
import type { LiveAgent } from '../agents/types.js';
import type { WorktreeSession } from './history.js';
import { findSessionForCwd } from '../comments/pending-delivery.js';
import { sessionIdFor } from './session-id.js';

/**
 * Running agents by work session, and what the dashboard says about them.
 * Which processes run is each agent's to say (agents/: `live`; Claude's is
 * agents/claude-live.ts, re-exported here).
 */

/** A running Claude: the agents' LiveAgent (agents/types.ts). */

/** Group by work session (a Claude outside any session is left out). */
export function agentsBySession(list: LiveAgent[], sessions: WorktreeSession[]): Map<string, LiveAgent[]> {
  const out = new Map<string, LiveAgent[]>();
  for (const c of list) {
    const s = findSessionForCwd(c.cwd, sessions);
    if (!s) continue;
    const id = sessionIdFor(s);
    out.set(id, [...(out.get(id) ?? []), c]);
  }
  return out;
}

/**
 * What the dashboard says about a session's running Claudes. `appPids` are
 * the ones the app runs itself (the PTY host's); the rest were
 * started in a terminal. `duplicate`: two or more on one conversation — they
 * would both write to it.
 */
export function summarizeAgents(list: LiveAgent[], appPids: ReadonlySet<number>): SessionClaudes | null {
  if (list.length === 0) return null;
  const inApp = list.filter((c) => appPids.has(c.pid)).length;
  const perConversation = new Map<string, number>();
  for (const c of list) perConversation.set(c.conversationId, (perConversation.get(c.conversationId) ?? 0) + 1);
  // The most telling one: any mid-turn, else any waiting on you, else idle.
  const pick = list.find((c) => c.state === 'busy') ?? list.find((c) => c.state === 'waiting') ?? list.find((c) => c.state === 'idle');
  return {
    inTerminal: list.length - inApp,
    inApp,
    busy: list.some((c) => c.busy),
    duplicate: [...perConversation.values()].some((n) => n > 1),
    ...(pick?.state
      ? {
          state: pick.state,
          ...(pick.stateAt ? { stateAt: pick.stateAt } : {}),
          ...(pick.waitingFor ? { waitingFor: pick.waitingFor } : {}),
        }
      : {}),
  };
}
