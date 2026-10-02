import { getAiTool } from '../ai-launcher.js';
import type { WorkConfig } from '../config.js';
import { claudeAgent } from './claude.js';
import type { AgentAdapter } from './types.js';

export type { AgentAdapter, ConversationEntry } from './types.js';

/**
 * The agent a session runs (config `aiCommand`; Claude Code by default).
 * Claude is the only adapter so far; any other tool gets one with just its
 * name, so every capability reads as "not available for <tool>".
 */
export function agentFor(config: Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null): AgentAdapter {
  const cmd = getAiTool(config ?? {}).cmd;
  return cmd === 'claude' ? claudeAgent : { id: cmd, name: cmd };
}
