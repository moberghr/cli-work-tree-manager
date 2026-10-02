import type { WorktreeSession } from '../history.js';

/**
 * What work needs from a coding agent (Claude Code today; Codex, Copilot CLI
 * or opencode later), so the rest of work asks the agent instead of reading
 * Claude Code's files itself. This is the first slice: reading a session's
 * conversation. Every capability past `id` is optional, and a feature whose
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

export interface AgentAdapter {
  /** The agent's binary name (`claude`, `codex`, …). */
  id: string;
  /** How work names it to you ("Claude Code"). */
  name: string;
  /** Reading its conversations; absent: work can't for this agent. */
  conversation?: AgentConversation;
}
