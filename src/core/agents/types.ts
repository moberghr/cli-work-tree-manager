import type { WorktreeSession } from '../history.js';
import type { AiToolSpec } from '../ai-launcher.js';
import type { WorkConfig } from '../config.js';

/**
 * What work needs from a coding agent (Claude Code today; Codex, Copilot CLI
 * or opencode later), so the rest of work asks the agent instead of reading
 * Claude Code's files itself. This is the first slice: reading a session's
 * conversation, and starting it (`launch`, which every agent has). Every
 * other capability is optional, and a feature whose
 * capability an agent lacks says so instead of going quiet.
 */

/** One message of a session's conversation, in work's own terms (not any agent's file format). */
export interface ConversationEntry {
  /** When it was written (ISO). */
  at: string;
  /** You typed it; the agent wrote it; or a tool call the agent made. */
  role: 'you' | 'agent' | 'tool';
  /** The text, or for a tool call what it does ("npm test", a file path). */
  text: string;
  /** For a tool call: the tool's name (Bash, Edit, …). */
  tool?: string;
}

export interface AgentConversation {
  /** The newest `last` entries of the session's conversation, oldest first. */
  read(session: WorktreeSession, opts: { last: number }): ConversationEntry[];
}

/** Starting it: every agent has this. */
export interface AgentLaunch {
  /** Its binary and flags: config `aiCommand` / `aiCommandFlags` when they name this agent, else its defaults. */
  tool(config: Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null): AiToolSpec;
  /** Its resume flag finds a conversation in this folder. Passing it where there is none errors out (Claude Code: "No conversation found to continue"), so every launch path asks. */
  canResume(cwd: string): boolean;
  /** Where to start a session to pick up its conversation (a group may have worked in its root or a repo), and whether there is one. */
  resumeLaunch(session: WorktreeSession): { launchPath: string; hasConversation: boolean };
  /** The environment to start it with: what a parent session of this agent set (it would think it runs inside one) taken out. */
  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
}

export interface AgentAdapter {
  /** The agent's binary name (`claude`, `codex`, …). */
  id: string;
  /** How work names it to you ("Claude Code"). */
  name: string;
  launch: AgentLaunch;
  /** Reading its conversations; absent: work can't for this agent. */
  conversation?: AgentConversation;
}
