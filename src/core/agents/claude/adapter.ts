import path from 'node:path';
import { listTranscripts } from './files.js';
import { getAiTool } from '../../platform/ai-launcher.js';
import { claudeProjectsRoot, encodeProjectDir, getClaudeActivityMs, hasClaudeConversation, resolveResumeLaunch } from './activity.js';
import { withoutParentSession } from './env.js';
import { readTranscriptTail } from './transcript.js';
import { claudeContextWindow, claudeEntries } from './entries.js';
import { claudeEvents } from './hooks.js';
import { claudeSessionsDir, readLiveClaudes } from './live.js';
import { ANSWER_KEYS, checkDialog } from './permission.js';
import { typeThenEnter } from '../typing.js';
import { internalClaudeSpawn } from './internal.js';
import { claudeChat } from './chat.js';
import { claudeWorkspace } from './workspace.js';
import { claudeSkills } from './skills.js';

/** A few words (checkpoint names, once per changed turn): a small model does. */
export const CLAUDE_SMALL_MODEL = 'haiku';
import type { AgentAdapter, ConversationEntry } from '../types.js';

export { claudeEntries } from './entries.js';

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
    // Its projects folder for the folder Claude runs in (the worktree, or a group's root): `--continue` finds it there.
    lastWriteMs: (cwd) => getClaudeActivityMs(cwd),
    restoreDir: (s) => {
      const cwd = s.isGroup && s.paths[0] ? path.dirname(s.paths[0]) : s.paths[0];
      return cwd ? path.join(claudeProjectsRoot(), encodeProjectDir(cwd)) : null;
    },
  },
  events: claudeEvents,
  // Its transcripts, and the per-process state files (a Claude opened or closed in a terminal tab shows at once).
  activityRoots: () => [claudeProjectsRoot(), claudeSessionsDir()],
  live: { running: (table) => readLiveClaudes(undefined, undefined, table) },
  input: {
    submit: typeThenEnter,
    // Its dialog: "Do you want to …?" over a menu with "❯ 1. Yes"; Enter takes Yes, Esc is "No, and tell Claude what to do differently".
    permissionDialog: { check: checkDialog, keys: { allow: ANSWER_KEYS.allow, deny: ANSWER_KEYS.deny } },
  },
  // `claude -p --tools "" --strict-mcp-config [--model haiku]` in a neutral folder, tagged internal.
  oneShot: { command: ({ small }) => ({ cmd: 'claude', ...internalClaudeSpawn(small ? { model: CLAUDE_SMALL_MODEL } : {}) }) },
  instructionsFile: 'CLAUDE.md',
  chat: claudeChat,
  workspace: claudeWorkspace,
  skills: claudeSkills,
};
