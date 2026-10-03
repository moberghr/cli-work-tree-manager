import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath } from '../config.js';
import { getAiTool } from '../ai-launcher.js';
import type { WorkConfig } from '../config.js';
import type { WorktreeSession } from '../session-types.js';
import type { SessionAgentWire } from '../api-types.js';
import { claudeAgent } from './claude.js';
import type { AgentAdapter, LiveAgent } from './types.js';
import { typeThenEnter } from './typing.js';

export type { AgentAdapter, AgentLaunch, ConversationEntry, LiveAgent, TurnEdge, WorkHook } from './types.js';

type ToolConfig = Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null;
type AgentSettings = Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags' | 'internalAgent' | 'assistantAgent'>;

/**
 * The config's agent settings (aiCommand, aiCommandFlags, internalAgent, assistantAgent),
 * read again only when config.json changed (its path, size and mtime): the
 * agent lookups run per session on every session-list build, and a full
 * loadConfig each time was a read and a parse per row.
 */
let settingsCache: { key: string; value: AgentSettings } | null = null;
export function agentSettings(): AgentSettings {
  const file = getConfigPath();
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${file}|${st.size}|${st.mtimeMs}`;
  } catch {
    return {};
  }
  if (settingsCache?.key === key) return settingsCache.value;
  let value: AgentSettings = {};
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    value = {
      ...(typeof p.aiCommand === 'string' ? { aiCommand: p.aiCommand } : {}),
      ...(p.aiCommandFlags && typeof p.aiCommandFlags === 'object' ? { aiCommandFlags: p.aiCommandFlags as AgentSettings['aiCommandFlags'] } : {}),
      ...(typeof p.internalAgent === 'string' && /^[\w.-]+$/.test(p.internalAgent) ? { internalAgent: p.internalAgent } : {}),
      ...(typeof p.assistantAgent === 'string' && /^[\w.-]+$/.test(p.assistantAgent) ? { assistantAgent: p.assistantAgent } : {}),
    };
  } catch {
    /* unreadable: the defaults */
  }
  settingsCache = { key, value };
  return value;
}

/** The agent a session runs, with the config's settings (cached): `agentFor(agentSettings(), session)`. */
export function agentOf(session?: Pick<WorktreeSession, 'agent'> | null): AgentAdapter {
  return agentFor(agentSettings(), session);
}

/** The agents work has an adapter for, by binary name. */
const ADAPTERS = new Map<string, AgentAdapter>([[claudeAgent.id, claudeAgent]]);

/**
 * Add an adapter (another agent — Codex, Copilot CLI — or a test's): from
 * then on sessions created with it record it, and every reader, hook and
 * launch path uses it. Returns a function that takes it out again.
 */
export function registerAgent(a: AgentAdapter): () => void {
  const before = ADAPTERS.get(a.id);
  ADAPTERS.set(a.id, a);
  return () => {
    if (before) ADAPTERS.set(a.id, before);
    else ADAPTERS.delete(a.id);
  };
}

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
    // Text, a pause, Enter — and no dialog to answer by keystroke (its screen is unknown).
    input: { submit: typeThenEnter },
    // The shared convention (Codex, Copilot CLI, opencode read it).
    instructionsFile: 'AGENTS.md',
  };
}

/** Every agent work has an adapter for (whose hooks work web installs, whose running processes it reads). */
export function knownAgents(): AgentAdapter[] {
  return [...ADAPTERS.values()];
}

/** Every known agent's running processes, wherever they were started (each agent's `live`). */
export function liveAgents(table?: ReadonlyMap<number, string>): LiveAgent[] {
  return knownAgents().flatMap((a) => a.live?.running(table) ?? []);
}

/** The agent the Ctrl+K assistant runs (config `assistantAgent`; Claude Code by default). */
export function assistantAgent(config: Pick<WorkConfig, 'assistantAgent'> | null): AgentAdapter {
  return agentById(config?.assistantAgent ?? 'claude');
}

/** The agent that writes work's own summaries (config `internalAgent`; Claude Code by default). */
export function internalAgent(config: Pick<WorkConfig, 'internalAgent'> | null): AgentAdapter {
  return agentById(config?.internalAgent ?? 'claude');
}

/** An agent as the dashboard is told about it: its name and which capabilities its adapter has. */
export function agentWire(a: AgentAdapter): SessionAgentWire {
  return {
    id: a.id,
    name: a.name,
    can: { read: !!a.conversation, hooks: !!a.events, live: !!a.live, answer: !!a.input.permissionDialog, chat: !!a.chat },
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
