import path from 'node:path';
import { getAiTool } from '../ai-launcher.js';
import type { WorkConfig } from '../config.js';
import type { WorktreeSession } from '../session-types.js';
import { claudeAgent } from './claude.js';
import type { AgentAdapter } from './types.js';

export type { AgentAdapter, AgentLaunch, ConversationEntry } from './types.js';

type ToolConfig = Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null;

/**
 * An agent work has no adapter for (opencode, or whatever `aiCommand`
 * names): it starts — the binary, its preset flags — but nothing else is
 * known about it. It never resumes (a resume flag where there is no
 * conversation can error out), and every other capability reads as "not
 * available for <tool>".
 */
function plainAgent(id: string): AgentAdapter {
  return {
    id,
    name: id,
    launch: {
      tool: (config) => getAiTool(config && getAiTool(config).cmd === id ? config : { aiCommand: id }),
      canResume: () => false,
      resumeLaunch: (s) => ({ launchPath: s.isGroup ? path.dirname(s.paths[0] ?? '') : (s.paths[0] ?? ''), hasConversation: false }),
      cleanEnv: (env) => ({ ...env }),
    },
  };
}

/** The adapter for an agent by its binary name (`claude`; anything else: a plain one). */
export function agentById(id: string): AgentAdapter {
  return id === 'claude' ? claudeAgent : plainAgent(id);
}

/**
 * The agent a session runs: the one it recorded when it was created
 * (`WorktreeSession.agent`), else the configured default (`aiCommand`,
 * Claude Code when unset). Without a session: the default.
 */
export function agentFor(config: ToolConfig, session?: Pick<WorktreeSession, 'agent'> | null): AgentAdapter {
  return agentById(session?.agent ?? getAiTool(config ?? {}).cmd);
}
