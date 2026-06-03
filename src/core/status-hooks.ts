/**
 * Opt-in, user-configurable shell commands that run when a background session
 * changes status (idle / needs input). Generalizes the desktop-notification
 * path: instead of a fixed OS notification, the user can run any command from
 * their own config (e.g. play a sound, ping a webhook, focus a window).
 *
 * Each hook is spawned fire-and-forget with the session directory as cwd
 * (passed as the spawn `cwd` option — never interpolated into the command
 * string). Commands run with `shell: true` intentionally, since they come only
 * from the user's own `~/.work/config.json`. Mirrors notifier.ts's defensive
 * style: a bad command never throws back to the caller.
 */

import { spawn } from 'node:child_process';
import type { StatusHook } from './config.js';

/**
 * Run every configured status hook whose `on` matches `kind`, fire-and-forget.
 * No-op when `hooks` is undefined/empty or nothing matches. Never throws.
 *
 * @param kind        The status the session changed to.
 * @param cwd         Session directory; used as the spawned command's cwd.
 * @param sessionName Friendly session name, exposed as $WORK_SESSION.
 * @param hooks       The configured hooks (from WorkConfig.statusHooks).
 */
export function runStatusHooks(
  kind: 'idle' | 'needs_input',
  cwd: string,
  sessionName: string,
  hooks: StatusHook[] | undefined,
): void {
  if (!hooks || hooks.length === 0) return;

  for (const hook of hooks) {
    if (hook.on !== kind) continue;
    try {
      const child = spawn(hook.command, {
        cwd,
        shell: true,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          WORK_SESSION: sessionName,
          WORK_STATUS: kind,
        },
      });
      // Swallow async spawn errors (e.g. ENOENT); without a handler these
      // would surface as an uncaught exception.
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      /* bad command — silent no-op, never throw back to the caller */
    }
  }
}
