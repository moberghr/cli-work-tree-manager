import { readJsonlTail } from './jsonl.js';
import { agentOf } from '../agents/index.js';
import type { ConversationEntry } from '../agents/types.js';
import type { ContextUsage } from '../api-types.js';
import type { WorktreeSession } from '../sessions/session-types.js';

export type { ContextUsage } from '../api-types.js';

/**
 * How full a session's conversation is. Every assistant message in the
 * transcript carries the token usage of the request that produced it, so
 * the newest one says how big the context is now: its prompt (input +
 * cache reads + cache writes) plus its reply, which the next turn carries.
 * Near the window Claude Code compacts the conversation, and answers get
 * worse before that — the dashboard shows when to start fresh.
 */


/** From conversation entries (oldest first): the newest main-thread usage, in the agent's window (`window`). */
export function contextUsageFrom(entries: readonly ConversationEntry[], window: (model: string | undefined, used: number) => number): ContextUsage | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // Subagent (Task) turns run in their own context.
    if (e.role !== 'agent' || e.sidechain || !e.usage) continue;
    const used = e.usage.prompt + e.usage.reply;
    if (used === 0) continue;
    return { used, window: window(e.model, used), ...(e.model ? { model: e.model } : {}) };
  }
  return null;
}

// Claude Code's transcript files, for the callers that still read Claude's own records (chat, turn activity): agents/claude-files.ts.
export type { ConversationFile as TranscriptFile } from '../agents/types.js';

/** Only the tail is read — a usage line is always near the end. */
const USAGE_TAIL_BYTES = 64 * 1024;
const cache = new Map<string, { key: string; usage: ContextUsage | null }>();

/** The session's context usage now, through its agent; re-reads a conversation only after it changed. Null when work can't read its agent's conversations. */
export function readContextUsage(session: WorktreeSession): ContextUsage | null {
  const conv = agentOf(session).conversation;
  if (!conv) return null;
  let t: { file: string; size: number; mtimeMs: number } | null = null;
  for (const f of conv.files(session)) if (!t || f.mtimeMs > t.mtimeMs) t = f;
  if (!t) return null;
  const key = `${t.file}:${t.size}:${t.mtimeMs}`;
  const id = session.paths.join('|');
  const hit = cache.get(id);
  if (hit?.key === key) return hit.usage;
  const usage = contextUsageFrom(conv.entries(readJsonlTail(t.file, USAGE_TAIL_BYTES)), conv.contextWindow);
  cache.set(id, { key, usage });
  return usage;
}
