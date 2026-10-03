import { lastAssistantText } from '../session-status.js';
import { pendingToolUse } from '../permission-request.js';
import { readTranscriptTail } from '../transcript.js';
import type { StatusEvent } from '../status-event.js';
import type { AgentEvents, TurnEdge, WorkHook } from './types.js';

/**
 * Claude Code's side of work's hooks (types.ts `AgentEvents`): command hooks
 * in ~/.claude/settings.json (command-hook-installer.ts), and the JSON Claude
 * Code sends them on stdin. The command is `work hook <edge>` as before, so an
 * install changes nothing in a settings file already right.
 *
 * The installer (and its file lock) is loaded only to install: every hook
 * process imports this adapter, on every turn edge of every Claude, and
 * reading a payload needs none of it.
 */

type Installer = typeof import('../command-hook-installer.js');
let installer: Installer | null = null;
const loadInstaller = async (): Promise<Installer> => (installer ??= await import('../command-hook-installer.js'));

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

export const claudeEvents: AgentEvents = {
  install: async (hooks: WorkHook[], remove = []) =>
    (await loadInstaller()).syncCommandHooks(
      hooks.map((h) => ({ ...toClaude(h), command: h.command, ...(h.timeoutSec ? { timeoutSec: h.timeoutSec } : {}) })),
      remove.map(toClaude),
    ),
  // A shutdown handler can't wait for an import: it uses the installer the
  // start-up install loaded (work web always installs first). Nothing loaded:
  // this process installed nothing, so there is nothing of its to remove.
  removeSync: (hooks) => installer?.removeCommandHooksSync(hooks.map(toClaude)),
  read: (edge, payload) => ({ cwd: str(asPayload(payload).cwd), status: claudeStatusEvent(edge, payload) }),
  // turn-start: stdout is added to the prompt. turn-end: `decision: block`
  // keeps Claude in the turn and feeds `reason` back to it.
  handOver: (edge, text) => (edge === 'turn-start' ? text + '\n' : JSON.stringify({ decision: 'block', reason: text }) + '\n'),
};
