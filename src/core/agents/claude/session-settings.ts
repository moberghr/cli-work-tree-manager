import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../../platform/config-dir.js';
import { atomicWriteFile } from '../../platform/fs-safe.js';
import { loadConfig } from '../../platform/config.js';
import { workCommand, type WorkInvocationDeps } from '../../platform/work-command.js';
import type { AiToolSpec } from '../../platform/ai-launcher.js';
import { SESSION_HOOKS } from '../session-hooks.js';
import { CLAUDE_EVENT } from './hooks.js';

/**
 * work's hooks and status line for the Claudes work starts, and only those: a settings file of work's own
 * (`~/.work/claude-settings.json`) handed to each with `claude --settings <it>`. Claude Code adds hooks from it to the
 * user's and the project's (measured: a UserPromptSubmit hook in each ran), and its status line takes the place of the
 * user's for that process — the hook runs the user's own after recording the plan limits (statusline-hook.ts).
 *
 * Before, work web wrote them into `~/.claude/settings.json` (and each account's): every Claude on the machine ran
 * them, with whatever `work` its PATH found first, and the file — often in a dotfiles repo — changed at each start.
 *
 * Each command names the work that wrote the file (work-command.ts), so the hooks run the build that knows their names.
 * Written again at every spawn (the PTY host's, or a launch in a terminal): after an update it names the new one.
 */

export const SESSION_SETTINGS_NAME = 'claude-settings.json';

export const sessionSettingsPath = (): string => path.join(getConfigDir(), SESSION_SETTINGS_NAME);

/** The settings themselves. `statusLine: false` (config `usage.statusLine: false`): the user's own line, untouched. */
export function claudeSessionSettings(o: { statusLine: boolean; invocation?: WorkInvocationDeps }): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const h of SESSION_HOOKS) {
    (hooks[CLAUDE_EVENT[h.edge]] ??= []).push({
      hooks: [{ type: 'command', command: workCommand(['hook', h.event], o.invocation), timeout: h.timeoutSec }],
    });
  }
  return {
    hooks,
    ...(o.statusLine ? { statusLine: { type: 'command', command: workCommand(['hook', 'statusline'], o.invocation) } } : {}),
  };
}

/** Write the file when it differs from what's there (a spawn mustn't rewrite it for nothing); its path. */
export function writeSessionSettings(o: { statusLine?: boolean; invocation?: WorkInvocationDeps } = {}): string {
  const file = sessionSettingsPath();
  const statusLine = o.statusLine ?? loadConfig()?.usage?.statusLine !== false;
  const text = JSON.stringify(claudeSessionSettings({ statusLine, invocation: o.invocation }), null, 2) + '\n';
  let now: string | null = null;
  try {
    now = fs.readFileSync(file, 'utf-8');
  } catch {
    /* not there yet */
  }
  if (now !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFile(file, text);
  }
  return file;
}

const isOurs = (p: string | undefined) => !!p && path.basename(p) === SESSION_SETTINGS_NAME;

/** The file to name: written when `write` (the default), or when it isn't there yet (a Claude given a missing file won't start). */
export function sessionSettingsFile(o: { write?: boolean } = {}): string {
  const file = sessionSettingsPath();
  return o.write === false && fs.existsSync(file) ? file : writeSessionSettings();
}

/** A Claude's command line names work's file: it was started with work's hooks. */
export const startedWithSessionSettings = (commandLine: string): boolean => commandLine.includes(SESSION_SETTINGS_NAME);

/**
 * The tool as work starts it for a session: `--settings <work's file>` first, once — an older one (a restore entry
 * written before, or under another home) replaced. `file`: tests.
 */
export function withSessionSettings(tool: AiToolSpec, file: string = sessionSettingsFile()): AiToolSpec {
  const rest: string[] = [];
  for (let i = 0; i < tool.baseArgs.length; i++) {
    if (tool.baseArgs[i] === '--settings' && isOurs(tool.baseArgs[i + 1])) {
      i++;
      continue;
    }
    rest.push(tool.baseArgs[i]!);
  }
  return { ...tool, baseArgs: ['--settings', file, ...rest] };
}
