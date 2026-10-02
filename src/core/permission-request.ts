import path from 'node:path';
import { contentBlocks, type TranscriptEntry } from './transcript.js';
import type { PermissionRequest } from './api-types.js';

export type { PermissionRequest } from './api-types.js';

/**
 * "Claude needs your permission to use Bash" says which tool, not what it
 * wants to run. The transcript does: the tool call Claude is blocked on is
 * the newest `tool_use` with no `tool_result` yet. That is what the inbox
 * shows next to Allow / Deny, so you approve the command, not the tool.
 */

// The part of a tool call a person needs to judge it: claude-entries.ts (one reader of Claude's lines).
export { describeToolUse } from './agents/claude-entries.js';
import { describeToolUse } from './agents/claude-entries.js';

/**
 * The tool call Claude is waiting on, or null. With parallel calls Claude
 * Code asks about them in order, so it is the first unanswered call of the
 * newest assistant run (older unanswered calls belong to interrupted turns).
 */
export function pendingToolUse(entries: TranscriptEntry[]): PermissionRequest | null {
  const answered = new Set<string>();
  for (const e of entries) {
    for (const b of contentBlocks(e)) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') answered.add(b.tool_use_id);
    }
  }
  let found: PermissionRequest | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user') {
      if (found) break; // start of the run that holds the newest pending call
      continue;
    }
    if (e.type !== 'assistant') continue;
    const blocks = contentBlocks(e);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (typeof b.id === 'string' && answered.has(b.id)) continue;
      found = { tool: b.name, detail: describeToolUse(b.name, b.input) };
    }
  }
  return found;
}

// ---- the dialog on screen -----------------------------------------------

/** Claude Code's permission dialog: a "Do you want to …?" question over a
 *  numbered menu whose first option is Yes. */
const QUESTION_RE = /Do you want to\b/;
const YES_SELECTED_RE = /❯\s*1\.\s*Yes\b/;

/** Whitespace and box-drawing borders go: the dialog is drawn in a box,
 *  so a wrapped command reads "…permission-│\n│   request.ts…". */
const squash = (s: string) => s.replace(/[\s\u2500-\u257f]+/g, '');

/** Text that must be on screen for the dialog to be about THIS request:
 *  the start of the command (terminal wrapping only breaks it at spaces we
 *  squash away), or the file name. */
export function screenAnchor(req: PermissionRequest): string {
  if (req.tool === 'Bash' || req.tool === 'PowerShell') return squash(req.detail.split(' ⏎ ')[0]).slice(0, 40);
  if (/[\\/]/.test(req.detail) && !/^https?:/.test(req.detail)) return path.basename(req.detail.replace(/\\/g, '/'));
  return '';
}

export type DialogCheck =
  | { ok: true }
  | { ok: false; reason: 'no-dialog' | 'other-request' | 'not-default' };

/**
 * May we answer by keystroke? Only while the screen shows the permission
 * dialog, for the request the user was shown, with "1. Yes" highlighted
 * (so Enter means Yes). Anything else — already answered, a different
 * prompt, the user moved the cursor in their terminal — and we don't type.
 */
export function checkDialog(screen: string, req: PermissionRequest): DialogCheck {
  if (!QUESTION_RE.test(screen)) return { ok: false, reason: 'no-dialog' };
  const anchor = screenAnchor(req);
  if (anchor && !squash(screen).includes(anchor)) return { ok: false, reason: 'other-request' };
  if (!YES_SELECTED_RE.test(screen)) return { ok: false, reason: 'not-default' };
  return { ok: true };
}

/** Keys that answer the dialog: Enter on the highlighted Yes; Esc is Claude
 *  Code's "No, and tell Claude what to do differently". */
export const ANSWER_KEYS = { allow: '\r', deny: '\x1b' } as const;
export type PermissionAnswer = keyof typeof ANSWER_KEYS;
