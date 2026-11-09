import { agentFor, agentSettings, assistantAgent, internalAgent } from './index.js';
import type { AgentSettings } from './index.js';
import { ensureShellPath } from '../platform/shell-path.js';
import { debugLog } from '../platform/logger.js';

/**
 * The agents' commands, found on PATH before work web or the PTY host starts any of them
 * (`core/platform/shell-path.ts` says why: the Mac app from the Dock gets the system's PATH).
 */

/** The commands work starts agents with, from the registry: new sessions', the Ctrl+K assistant's, the summaries'. */
export function agentCommands(settings: AgentSettings = agentSettings()): string[] {
  return [...new Set([agentFor(settings), assistantAgent(settings), internalAgent(settings)].map((a) => a.launch.tool(settings).cmd))];
}

/** For `work web` and the PTY host as they start (not wd's lean server: it starts no agent). Never throws. */
export function ensureAgentPath(
  deps: { commands?: () => string[]; ensure?: (need: string[]) => ReturnType<typeof ensureShellPath> } = {},
): ReturnType<typeof ensureShellPath> | 'failed' {
  try {
    return (deps.ensure ?? ensureShellPath)((deps.commands ?? agentCommands)());
  } catch (err) {
    debugLog('WARN', 'finding the agents on PATH failed:', err);
    return 'failed';
  }
}
