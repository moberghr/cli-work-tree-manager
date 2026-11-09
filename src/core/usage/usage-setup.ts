import { logSwallowed } from '../platform/best-effort.js';
import type { AgentUsageSource } from '../agents/types.js';

/** What setup and restore need of an agent: its name and usage part (AgentAdapter fits). */
export interface UsageAgent {
  id: string;
  name: string;
  usage?: Pick<AgentUsageSource, 'setup' | 'restore'>;
}

/**
 * Work web's start: every agent with a usage part puts in place (or, with config `usage.statusLine: false`, takes away)
 * what records its readings. One agent's failure is logged and the rest go on; what each did is returned.
 */
export async function setupAgentUsage(
  agents: readonly UsageAgent[],
  config: { usage?: { statusLine?: boolean } } | null,
  lean: boolean,
): Promise<Array<{ agent: string; message: string }>> {
  const enabled = config?.usage?.statusLine !== false;
  const done: Array<{ agent: string; message: string }> = [];
  for (const a of agents) {
    if (!a.usage?.setup) continue;
    try {
      done.push({ agent: a.id, message: await a.usage.setup({ enabled, lean }) });
    } catch (e) {
      logSwallowed(`set up ${a.name}'s usage readings`, e);
    }
  }
  return done;
}

/** `work usage --restore`: each agent gives its own setting back. A failure is that agent's `ok: false`, with why. */
export async function restoreAgentUsage(
  agents: readonly UsageAgent[],
): Promise<Array<{ agent: string; name: string; ok: boolean; message: string }>> {
  const out: Array<{ agent: string; name: string; ok: boolean; message: string }> = [];
  for (const a of agents) {
    if (!a.usage?.restore) continue;
    try {
      out.push({ agent: a.id, name: a.name, ...(await a.usage.restore()) });
    } catch (e) {
      out.push({ agent: a.id, name: a.name, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
