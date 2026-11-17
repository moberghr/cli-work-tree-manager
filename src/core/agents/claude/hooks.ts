import path from 'node:path';
import { setUpAccounts } from './accounts.js';
import { pendingToolUse } from './permission.js';
import { contentBlocks, readTranscriptTail } from './transcript.js';
import type { StatusEvent } from '../../status/status-event.js';
import type { AgentEvents, TurnEdge } from '../types.js';
import { BRIDGE_OWNER, RETIRED_HOOK_OWNERS, SESSION_HOOKS } from '../session-hooks.js';

/**
 * Claude Code's side of work's hooks (types.ts `AgentEvents`): the JSON Claude Code sends them on stdin, and how notes
 * go back. The hooks themselves come with each Claude work starts (session-settings.ts, `--settings`); what work web
 * once wrote into ~/.claude/settings.json and each account's is taken out (`removeInstalled`).
 *
 * The installer (and its file lock) is loaded only to clean up: every hook process imports this adapter, on every turn
 * edge, and reading a payload needs none of it.
 */

type Installer = typeof import('../../platform/command-hook-installer.js');
let installer: Installer | null = null;
const loadInstaller = async (): Promise<Installer> => (installer ??= await import('../../platform/command-hook-installer.js'));

/** Claude Code's hook event for each of work's turn edges. */
export const CLAUDE_EVENT: Record<TurnEdge, string> = {
  'turn-start': 'UserPromptSubmit',
  'turn-end': 'Stop',
  notify: 'Notification',
};

/** What Claude Code sends a hook on stdin (the fields work reads). */
interface ClaudeHookPayload {
  cwd?: string;
  /** UserPromptSubmit */
  prompt?: string;
  /** Notification */
  message?: string;
  /** Notification: permission_prompt, idle_prompt, elicitation_dialog, auth_success… */
  notification_type?: string;
  /** Stop (and others): the conversation's JSONL transcript. */
  transcript_path?: string;
}

const asPayload = (p: unknown): ClaudeHookPayload => (p && typeof p === 'object' ? (p as ClaudeHookPayload) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** A Claude hook payload as a status event (the turn edge it came from known). */
/**
 * Text of the last assistant message in a Claude Code transcript, for the
 * "done" summary. Null when unreadable or there's no assistant text yet.
 */
export function lastAssistantText(transcriptPath: string | undefined): string | null {
  const entries = readTranscriptTail(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const text = contentBlocks(entries[i])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return null;
}

export function claudeStatusEvent(edge: TurnEdge, payload: unknown): StatusEvent | null {
  const p = asPayload(payload);
  switch (edge) {
    case 'turn-start':
      return { kind: 'prompt', prompt: str(p.prompt) };
    case 'turn-end':
      return { kind: 'stop', lastMessage: lastAssistantText(str(p.transcript_path)) ?? undefined };
    case 'notify': {
      // Which call the permission prompt is about: the transcript has it,
      // the hook message only names the tool.
      const request = pendingToolUse(readTranscriptTail(str(p.transcript_path)));
      const type = str(p.notification_type);
      return { kind: 'notification', message: str(p.message), ...(type ? { type } : {}), ...(request ? { request } : {}) };
    }
  }
}

const toClaude = (h: { owner: string; edge: TurnEdge }) => ({ owner: h.owner, event: CLAUDE_EVENT[h.edge] });

/** Every account's settings file: the default's first (`~/.claude/settings.json`); a configured account's only once its folder exists. */
const settingsFiles = (): string[] => setUpAccounts().map((a) => path.join(a.dir, 'settings.json'));

export const claudeEvents: AgentEvents = {
  removeInstalled: async (hooks) => {
    const inst = await loadInstaller();
    // One account's file that can't be written is reported by the editor and doesn't keep the others from being cleaned.
    for (const file of settingsFiles()) await inst.removeCommandHooks(hooks.map(toClaude), file);
  },
  bridge: async () => {
    const inst = await loadInstaller();
    const { workCommand } = await import('../../platform/work-command.js');
    const add = SESSION_HOOKS.map((h) => ({
      owner: BRIDGE_OWNER[h.edge],
      event: CLAUDE_EVENT[h.edge],
      // Word for word what session-settings.ts gives: a Claude with both runs it once.
      command: workCommand(['hook', h.event]),
      timeoutSec: h.timeoutSec,
    }));
    // The other retired owners' entries (a lean server's checkpoint hooks, the separate ones of before) go meanwhile.
    const kept = new Set(add.map((a) => `${a.owner} ${a.event}`));
    const remove = RETIRED_HOOK_OWNERS.map(toClaude).filter((r) => !kept.has(`${r.owner} ${r.event}`));
    for (const file of settingsFiles()) await inst.syncCommandHooks(add, remove, file);
  },
  read: (edge, payload) => ({ cwd: str(asPayload(payload).cwd), status: claudeStatusEvent(edge, payload) }),
  // turn-start: stdout is added to the prompt. turn-end: `decision: block`
  // keeps Claude in the turn and feeds `reason` back to it.
  handOver: (edge, text) => (edge === 'turn-start' ? text + '\n' : JSON.stringify({ decision: 'block', reason: text }) + '\n'),
};
