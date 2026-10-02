import { listTranscripts } from '../context-usage.js';
import { getAiTool } from '../ai-launcher.js';
import { hasClaudeConversation, resolveResumeLaunch } from '../claude-activity.js';
import { withoutParentSession } from '../claude-env.js';
import { promptText } from '../digest.js';
import { describeToolUse } from '../permission-request.js';
import { readTranscriptTail } from '../transcript.js';
import { contentBlocks, type TranscriptEntry } from '../transcript-entry.js';
import type { AgentAdapter, ConversationEntry } from './types.js';

/**
 * Claude Code as an agent (types.ts): its conversations are the JSONL
 * transcripts under ~/.claude/projects/<folder>/. Read from the end — the
 * newest transcripts, a tail of each — since only the last few messages
 * are asked for and a transcript runs to many megabytes of tool output.
 */

/** How much of each transcript's end is read, and how many transcripts at most. */
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 3;

/** A transcript's entries as conversation entries: your prompts, Claude's text, its tool calls. Pure. */
export function claudeEntries(entries: TranscriptEntry[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const e of entries) {
    const at = typeof e.timestamp === 'string' ? e.timestamp : '';
    if (!at || e.isSidechain === true) continue;
    const prompt = promptText(e);
    if (prompt) {
      out.push({ at, role: 'you', text: prompt });
      continue;
    }
    if (e.type !== 'assistant' || e.isMeta === true) continue;
    const blocks = contentBlocks(e);
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) out.push({ at, role: 'agent', text });
    for (const b of blocks) {
      if (b.type === 'tool_use' && typeof b.name === 'string') out.push({ at, role: 'tool', tool: b.name, text: describeToolUse(b.name, b.input) });
    }
  }
  return out;
}

export const claudeAgent: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',
  launch: {
    // The configured command when it is Claude (`claude --model opus`); plain `claude` otherwise.
    tool: (config) => getAiTool(config && getAiTool(config).cmd === 'claude' ? config : {}),
    canResume: hasClaudeConversation,
    resumeLaunch: resolveResumeLaunch,
    cleanEnv: (env) => withoutParentSession(env),
  },
  conversation: {
    read(session, { last }) {
      const files = listTranscripts(session).sort((a, b) => b.mtimeMs - a.mtimeMs);
      const got: ConversationEntry[] = [];
      for (const f of files.slice(0, MAX_FILES)) {
        got.push(...claudeEntries(readTranscriptTail(f.file, TAIL_BYTES)));
        if (got.length >= last) break; // the newest file had enough
      }
      return got.sort((a, b) => a.at.localeCompare(b.at)).slice(-last);
    },
  },
};
