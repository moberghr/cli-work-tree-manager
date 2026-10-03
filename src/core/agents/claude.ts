import { listTranscripts } from './claude-files.js';
import { getAiTool } from '../ai-launcher.js';
import { hasClaudeConversation, resolveResumeLaunch } from '../claude-activity.js';
import { withoutParentSession } from '../claude-env.js';
import { readTranscriptTail } from '../transcript.js';
import { claudeContextWindow, claudeEntries } from './claude-entries.js';
import { claudeEvents } from './claude-hooks.js';
import { readLiveClaudes } from './claude-live.js';
import type { AgentAdapter, ConversationEntry } from './types.js';

export { claudeEntries } from './claude-entries.js';

/**
 * Claude Code as an agent (types.ts): its conversations are the JSONL
 * transcripts under ~/.claude/projects/<folder>/ (claude-entries.ts reads
 * their lines). Reading the latest messages reads from the end — the newest
 * transcripts, a tail of each — since a transcript runs to many megabytes of
 * tool output.
 */

/** How much of each transcript's end `read` takes, and how many transcripts at most. */
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 3;

/** What `read` shows: your prompts, its messages, its tool calls — not results, empty lines or a subagent's. */
const shown = (e: ConversationEntry) => !e.sidechain && (e.role === 'you' || e.role === 'tool' || (e.role === 'agent' && e.text !== ''));

export const claudeAgent: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',
  launch: {
    // The configured command when it is Claude (`claude --model opus`); plain `claude` otherwise.
    tool: (config) => getAiTool(config && getAiTool(config).cmd === 'claude' ? config : {}),
    canResume: (cwd) => hasClaudeConversation(cwd),
    resumeLaunch: (s) => resolveResumeLaunch(s),
    cleanEnv: (env) => withoutParentSession(env),
  },
  conversation: {
    files: (s) => listTranscripts(s),
    entries: claudeEntries,
    contextWindow: claudeContextWindow,
    read(session, { last }) {
      const files = listTranscripts(session).sort((a, b) => b.mtimeMs - a.mtimeMs);
      const got: ConversationEntry[] = [];
      for (const f of files.slice(0, MAX_FILES)) {
        got.push(...claudeEntries(readTranscriptTail(f.file, TAIL_BYTES)).filter(shown));
        if (got.length >= last) break; // the newest file had enough
      }
      return got.sort((a, b) => a.at.localeCompare(b.at)).slice(-last);
    },
  },
  events: claudeEvents,
  live: { running: (table) => readLiveClaudes(undefined, undefined, table) },
};
