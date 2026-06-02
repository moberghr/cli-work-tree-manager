/**
 * Installs a `command`-type entry in `~/.claude/settings.json` so Claude
 * Code spawns our hook subcommand and injects its stdout into the
 * conversation. Distinct from `HookServer` (which uses `http`-type hooks
 * for fire-and-forget notifications) — command hooks let us return text
 * that becomes part of Claude's context.
 *
 * Each install is tagged via the shared `settings-editor` (owner + PID)
 * so stale entries from a crashed previous run get pruned automatically
 * and writes are atomic.
 *
 * SECURITY NOTE: the `command` we register is resolved against the user's
 * PATH at hook-fire time (not install time). If an attacker can shadow
 * `work` earlier in PATH between install and fire, they intercept review
 * comments. We accept this for V1 — the tool is local-only — but a future
 * hardening pass should resolve the absolute path of the running `work`
 * binary at install time and embed that instead.
 */

import {
  editSettings,
  editSettingsSync,
  isOwnerEntry,
  isStaleEntry,
  tag,
  type HookEntry,
} from './settings-editor.js';

export interface CommandHookOptions {
  owner: string;
  /** Claude Code hook event to register under (e.g. UserPromptSubmit). */
  event: string;
  /** Shell command to execute. Receives the hook payload on stdin. */
  command: string;
  /** Hook timeout in seconds. Default 5. */
  timeoutSec?: number;
}

const HOOK_TYPE = 'command';

export function installCommandHook(opts: CommandHookOptions): Promise<void> {
  return editSettings((s) => {
    if (!s.hooks) s.hooks = {};
    const list = (s.hooks[opts.event] ?? []) as HookEntry[];
    const cleaned = list.filter(
      (h) => !isStaleEntry(h) && !isOwnerEntry(h, opts.owner),
    );
    cleaned.push(
      tag(
        {
          hooks: [
            {
              type: HOOK_TYPE,
              command: opts.command,
              timeout: opts.timeoutSec ?? 5,
            },
          ],
        },
        opts.owner,
      ),
    );
    s.hooks[opts.event] = cleaned;
  });
}

export function removeCommandHook(owner: string, event: string): Promise<void> {
  return editSettings((s) => removeOwnerEntries(s, owner, event));
}

/** Synchronous variant for signal handlers. */
export function removeCommandHookSync(owner: string, event: string): void {
  editSettingsSync((s) => removeOwnerEntries(s, owner, event));
}

function removeOwnerEntries(
  s: { hooks?: Record<string, HookEntry[] | undefined> },
  owner: string,
  event: string,
): void {
  if (!s.hooks) return;
  const list = s.hooks[event];
  if (!Array.isArray(list)) return;
  s.hooks[event] = list.filter(
    (h) => !isStaleEntry(h) && !isOwnerEntry(h, owner),
  );
  if (s.hooks[event]!.length === 0) delete s.hooks[event];
}
