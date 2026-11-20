import { knownAgents } from './index.js';
import { RETIRED_HOOK_OWNERS } from './session-hooks.js';
import type { AgentAdapter, LiveAgent } from './types.js';

/**
 * Moving work's hooks out of the agents' own settings without a session missing a turn.
 *
 * Older builds wrote work's hooks into the user's settings (Claude: ~/.claude/settings.json); this one gives them to the
 * agents it starts (`launch.sessionTool`). An agent started before the update has none of its own and reads its
 * settings live (Claude Code's file watcher), so taking the old ones out at once would leave every session that was
 * running with no status, no comments handed over and no checkpoints. While such an agent runs in a work session, the
 * hooks stay in the settings (`events.bridge`: the commands `sessionTool` gives, word for word — an agent with both
 * runs each once, and the right work runs them); once none is left they go (`events.removeInstalled`).
 */

/** What the decision needs, for one agent: its running processes and how each was started. */
export interface HookMigrationInput {
  running: LiveAgent[];
  /** A process's command line (undefined: couldn't be read). */
  commandOf: (pid: number) => string | undefined;
  /** A folder is a work session's (or in one). */
  inSession: (cwd: string) => boolean;
  /** When this work web started: an agent started after it, outside the PTY host, was started by hand (no hooks either way). */
  since: number;
  /**
   * A process the PTY host runs. One started since `since` without work's hooks is still old: a host from before this
   * build restarting an entry it kept (`work restart`, an account switch) starts it again with no `--settings`.
   */
  fromHost?: (pid: number) => boolean;
  startedWithSessionHooks: (commandLine: string) => boolean;
}

/**
 * The agents still on the hooks older builds installed: in a work session, started before `since` (or when it isn't
 * known), and not started with work's own hooks — a command line that can't be read counts as not, so the hooks stay
 * rather than a session losing them.
 */
export function agentsOnOldHooks(i: HookMigrationInput): LiveAgent[] {
  return i.running.filter((a) => {
    if (!i.inSession(a.cwd)) return false;
    if (a.startedAt !== null && a.startedAt >= i.since && !i.fromHost?.(a.pid)) return false;
    const cmd = i.commandOf(a.pid);
    return !(cmd && i.startedWithSessionHooks(cmd));
  });
}

export type HookMigrationStep = { agent: string; done: 'bridged'; waitingOn: number } | { agent: string; done: 'removed' };

export interface HookMigrationIo {
  agents?: () => AgentAdapter[];
  /** pid → command line of every process (rejects or throws: none known). */
  commandLines: () => Promise<Map<number, string>>;
  inSession: (cwd: string) => boolean;
  since: number;
  /** The pids the PTY host runs (agentsOnOldHooks' `fromHost`). */
  hostPids?: () => ReadonlySet<number>;
}

/**
 * One step for every agent with hooks: bridged while an agent of it started before the update runs in a session,
 * removed once none does. Work web runs it at start and again until every agent is `removed`.
 */
export async function settleAgentHooks(io: HookMigrationIo): Promise<HookMigrationStep[]> {
  const out: HookMigrationStep[] = [];
  let lines: Map<number, string> | null = null;
  for (const agent of (io.agents ?? knownAgents)()) {
    if (!agent.events) continue;
    const startedWith = agent.launch.startedWithSessionHooks;
    const running = agent.live?.running() ?? [];
    let old: LiveAgent[] = [];
    if (startedWith && running.length > 0) {
      lines ??= await io.commandLines().catch(() => new Map<number, string>());
      const known = lines;
      old = agentsOnOldHooks({
        running,
        commandOf: (pid) => known.get(pid),
        inSession: io.inSession,
        since: io.since,
        fromHost: (pid) => io.hostPids?.().has(pid) ?? false,
        startedWithSessionHooks: startedWith,
      });
    }
    if (old.length > 0) {
      await agent.events.bridge();
      out.push({ agent: agent.id, done: 'bridged', waitingOn: old.length });
    } else {
      await agent.events.removeInstalled(RETIRED_HOOK_OWNERS);
      out.push({ agent: agent.id, done: 'removed' });
    }
  }
  return out;
}
