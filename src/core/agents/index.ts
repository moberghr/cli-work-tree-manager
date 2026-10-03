import path from 'node:path';
import { getAiTool } from '../ai-launcher.js';
import type { WorkConfig } from '../config.js';
import type { WorktreeSession } from '../session-types.js';
import { claudeAgent } from './claude.js';
import type { AgentAdapter } from './types.js';

export type { AgentAdapter, AgentLaunch, ConversationEntry } from './types.js';

type ToolConfig = Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null;

/** The agents work has an adapter for, by binary name. */
const ADAPTERS: ReadonlyMap<string, AgentAdapter> = new Map([[claudeAgent.id, claudeAgent]]);

/** work has an adapter for this agent (it can be recorded on a session and read). */
export function isKnownAgent(id: string | undefined): id is string {
  return !!id && ADAPTERS.has(id);
}

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
  return ADAPTERS.get(id) ?? plainAgent(id);
}

/** The agent a new session records: the configured one, when work has an adapter for it (undefined: it follows `aiCommand`). */
export function agentToRecord(config: ToolConfig): string | undefined {
  const cmd = getAiTool(config ?? {}).cmd;
  return isKnownAgent(cmd) ? cmd : undefined;
}

/**
 * The agent a session runs: the one it recorded when it was created
 * (`WorktreeSession.agent`, an agent work has an adapter for), else the
 * configured default (`aiCommand`, Claude Code when unset). An unknown
 * command is never pinned: a session follows `aiCommand` as it is (a wrapper
 * like `node my-agent.js` would otherwise come back as a bare `node`).
 */
export function agentFor(config: ToolConfig, session?: Pick<WorktreeSession, 'agent'> | null): AgentAdapter {
  return agentById(isKnownAgent(session?.agent) ? session.agent : getAiTool(config ?? {}).cmd);
}
