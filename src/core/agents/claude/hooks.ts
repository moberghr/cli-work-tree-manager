import path from 'node:path';
import { setUpAccounts } from './accounts.js';
import { pendingToolUse } from './permission.js';
import { contentBlocks, readTranscriptTail } from './transcript.js';
import type { StatusEvent } from '../../status/status-event.js';
import type { AgentEvents, TurnEdge, WorkHook } from '../types.js';

/**
 * Claude Code's side of work's hooks (types.ts `AgentEvents`): command hooks
 * in ~/.claude/settings.json — and each configured account's `<config dir>/settings.json`, since a Claude running on
 * another account reads those, not ~/.claude's (command-hook-installer.ts) — and the JSON Claude
 * Code sends them on stdin. The command is `work hook <edge>` as before, so an
 * install changes nothing in a settings file already right.
 *
 * The installer (and its file lock) is loaded only to install: every hook
 * process imports this adapter, on every turn edge of every Claude, and
 * reading a payload needs none of it.
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

/** Every account's settings file: the default's first (`~/.claude/settings.json`, as it always was); a configured account's
 *  only once its folder exists (installing would make it; work web's account sync gets it when it appears). */
const settingsFiles = (): string[] => setUpAccounts().map((a) => path.join(a.dir, 'settings.json'));

export const claudeEvents: AgentEvents = {
  install: async (hooks: WorkHook[], remove = []) => {
    const inst = await loadInstaller();
    const add = hooks.map((h) => ({ ...toClaude(h), command: h.command, ...(h.timeoutSec ? { timeoutSec: h.timeoutSec } : {}) }));
    // One account's file that can't be written is reported by the editor and doesn't keep the others from their hooks.
    for (const file of settingsFiles()) await inst.syncCommandHooks(add, remove.map(toClaude), file);
  },
  // A shutdown handler can't wait for an import: it uses the installer the
  // start-up install loaded (work web always installs first). Nothing loaded:
  // this process installed nothing, so there is nothing of its to remove.
  removeSync: (hooks) => {
    if (!installer) return;
    for (const file of settingsFiles()) installer.removeCommandHooksSync(hooks.map(toClaude), file);
  },
  read: (edge, payload) => ({ cwd: str(asPayload(payload).cwd), status: claudeStatusEvent(edge, payload) }),
  // turn-start: stdout is added to the prompt. turn-end: `decision: block`
  // keeps Claude in the turn and feeds `reason` back to it.
  handOver: (edge, text) => (edge === 'turn-start' ? text + '\n' : JSON.stringify({ decision: 'block', reason: text }) + '\n'),
};
