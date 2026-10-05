/**
 * Installs a `command`-type entry in `~/.claude/settings.json` so Claude
 * Code spawns our hook subcommand and injects its stdout into the
 * conversation — command hooks let us return text that becomes part of
 * Claude's context (and record status for the attention inbox).
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

import { editSettings, editSettingsSync, isOwnerEntry, isStaleEntry, HOOK_TAGS, tag, type HookEntry } from './settings-editor.js';

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
    const cleaned = list.filter((h) => !isStaleEntry(h) && !isOwnerEntry(h, opts.owner));
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

/** The hook commands work web installs in ~/.claude/settings.json. */
export const MANAGED_HOOK_COMMANDS: ReadonlySet<string> = new Set(
  ['prompt-submit', 'stop', 'checkpoint', 'checkpoint-seal', 'status-prompt', 'status-stop', 'status-notify', 'turn-start', 'turn-end'].map(
    (e) => `work hook ${e}`,
  ),
);

/**
 * An entry of only work's own hook commands that lost its tags. Whatever
 * else rewrites settings.json — Claude Code saving a setting, a Claude
 * editing the file — may drop the `_workHook*` keys it doesn't know. Work
 * then no longer saw the entry as its own and installed a new one beside
 * it on every start: copies piled up, and each ran on every turn.
 */
export function isUntaggedWorkEntry(h: HookEntry): boolean {
  if (typeof h[HOOK_TAGS.OWNER_TAG] === 'string') return false;
  const cmds = (h.hooks ?? []).map((x) => (typeof x.command === 'string' ? x.command.trim() : ''));
  return cmds.length > 0 && cmds.every((c) => MANAGED_HOOK_COMMANDS.has(c));
}

/** Drop untagged copies of work's own hooks from these events. */
function removeUntaggedWorkEntries(s: { hooks?: Record<string, HookEntry[] | undefined> }, events: Iterable<string>): void {
  if (!s.hooks) return;
  for (const event of events) {
    const list = s.hooks[event];
    if (!Array.isArray(list)) continue;
    s.hooks[event] = list.filter((h) => !isUntaggedWorkEntry(h));
    if (s.hooks[event]!.length === 0) delete s.hooks[event];
  }
}

/**
 * Install `install` and remove every `remove` (owner + event) in ONE write
 * of settings.json — one install per hook used to be one atomic rename
 * each, a burst Windows sometimes refused (EPERM while a Claude reads the
 * file). Stale entries (their process gone) and untagged copies of work's
 * own hooks are pruned on the way.
 */
export function syncCommandHooks(install: CommandHookOptions[], remove: Array<{ owner: string; event: string }> = []): Promise<void> {
  return editSettings((s) => {
    if (!s.hooks) s.hooks = {};
    removeUntaggedWorkEntries(s, new Set([...install, ...remove].map((x) => x.event)));
    for (const r of remove) removeOwnerEntries(s, r.owner, r.event);
    for (const opts of install) {
      const list = (s.hooks[opts.event] ?? []) as HookEntry[];
      const cleaned = list.filter((h) => !isStaleEntry(h) && !isOwnerEntry(h, opts.owner));
      cleaned.push(tag({ hooks: [{ type: HOOK_TYPE, command: opts.command, timeout: opts.timeoutSec ?? 5 }] }, opts.owner));
      s.hooks[opts.event] = cleaned;
    }
  });
}

/** Remove several owner + event entries in one write (signal handlers: synchronous). */
export function removeCommandHooksSync(remove: Array<{ owner: string; event: string }>): void {
  editSettingsSync((s) => {
    removeUntaggedWorkEntries(s, new Set(remove.map((r) => r.event)));
    for (const r of remove) removeOwnerEntries(s, r.owner, r.event);
  });
}

export function removeCommandHook(owner: string, event: string): Promise<void> {
  return editSettings((s) => removeOwnerEntries(s, owner, event));
}

/** Synchronous variant for signal handlers. */
export function removeCommandHookSync(owner: string, event: string): void {
  editSettingsSync((s) => removeOwnerEntries(s, owner, event));
}

function removeOwnerEntries(s: { hooks?: Record<string, HookEntry[] | undefined> }, owner: string, event: string): void {
  if (!s.hooks) return;
  const list = s.hooks[event];
  if (!Array.isArray(list)) return;
  s.hooks[event] = list.filter((h) => !isStaleEntry(h) && !isOwnerEntry(h, owner));
  if (s.hooks[event]!.length === 0) delete s.hooks[event];
}
