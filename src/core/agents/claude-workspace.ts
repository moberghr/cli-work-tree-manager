import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../fs-safe.js';
import { CLAUDE_EVENT } from './claude-hooks.js';
import type { AgentWorkspace, AllowRule } from './types.js';

/**
 * Claude Code's side of a folder work runs it in (types.ts `AgentWorkspace`;
 * the Ctrl+K assistant's): the folder's project settings,
 * `.claude/settings.json` — its permission rules and its command hooks.
 * Those are work's; the user's own "don't ask again" choices go to
 * `.claude/settings.local.json`, which this never touches.
 */

/** A rule in Claude Code's terms: `Bash(cmd)` is exactly that command, `Bash(cmd:*)` that and anything after. */
export const claudeAllowRule = (r: AllowRule): string => `Bash(${r.command}${r.prefix ? ':*' : ''})`;

export const claudeWorkspace: AgentWorkspace = {
  write(dir, { allow, hooks }) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const byEvent: Record<string, Array<{ hooks: Array<{ type: 'command'; command: string; timeout?: number }> }>> = {};
    for (const h of hooks) {
      (byEvent[CLAUDE_EVENT[h.edge]] ??= []).push({ hooks: [{ type: 'command', command: h.command, ...(h.timeoutSec ? { timeout: h.timeoutSec } : {}) }] });
    }
    const settings = { permissions: { allow: allow.map(claudeAllowRule) }, hooks: byEvent };
    atomicWriteFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    return [path.join('.claude', 'settings.json')];
  },
};
