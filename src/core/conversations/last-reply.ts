import type { ConversationEntry } from '../agents/types.js';

/**
 * The text of the agent's newest message — what "Copy Claude's last reply"
 * copies: the Markdown as it wrote it, not the terminal's drawing of it
 * (wrapped at the screen's width, indented, padded with spaces). A
 * sub-agent's message (`sidechain`) isn't its reply. Pure.
 */
export function lastReplyOf(entries: readonly ConversationEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.role === 'agent' && !e.sidechain && e.text.trim()) return e.text.trim();
  }
  return null;
}
