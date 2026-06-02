/**
 * Best-effort desktop notifications for session lifecycle events. Used by the
 * dashboard hook callback to alert the user when a background Claude session
 * goes idle (finished its turn) or needs input — so parallel sessions don't
 * have to be babysat in the TUI.
 *
 * Opt-in via `WorkConfig.notifications`. Cross-platform with a graceful no-op
 * when the platform is unsupported or the notifier binary is absent. Spawns
 * fire-and-forget via cross-spawn argv arrays (never a shell string) and never
 * throws back to the caller.
 */

import spawn from 'cross-spawn';

export type NotifyKind = 'idle' | 'needs_input';

const MESSAGES: Record<NotifyKind, string> = {
  idle: 'Idle — finished its turn',
  needs_input: 'Needs your input',
};

/** Drop control characters that could break notifier argument parsing. */
function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** Escape for embedding inside an AppleScript double-quoted string literal. */
function escapeAppleScript(s: string): string {
  return sanitize(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape for a PowerShell single-quoted string literal (double the quote). */
function escapePwshSingle(s: string): string {
  return sanitize(s).replace(/'/g, "''");
}

/**
 * Build the notifier command for a platform. Pure and side-effect-free so it
 * can be unit-tested without spawning. Returns null for unsupported platforms.
 */
export function buildNotifyCommand(
  sessionName: string,
  kind: NotifyKind,
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } | null {
  const title = `work: ${sessionName}`;
  const message = MESSAGES[kind];

  if (platform === 'darwin') {
    const t = escapeAppleScript(title);
    const m = escapeAppleScript(message);
    return {
      cmd: 'osascript',
      args: ['-e', `display notification "${m}" with title "${t}"`],
    };
  }

  if (platform === 'linux') {
    // notify-send takes title/message as separate argv args — injection-safe.
    return { cmd: 'notify-send', args: [sanitize(title), sanitize(message)] };
  }

  if (platform === 'win32') {
    const t = escapePwshSingle(title);
    const m = escapePwshSingle(message);
    // Built-in balloon tip via System.Windows.Forms — no external module.
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      'Add-Type -AssemblyName System.Windows.Forms;' +
      'Add-Type -AssemblyName System.Drawing;' +
      '$n=New-Object System.Windows.Forms.NotifyIcon;' +
      '$n.Icon=[System.Drawing.SystemIcons]::Information;' +
      '$n.Visible=$true;' +
      `$n.ShowBalloonTip(5000,'${t}','${m}',[System.Windows.Forms.ToolTipIcon]::Info);` +
      'Start-Sleep -Seconds 6;$n.Dispose()';
    return { cmd: 'powershell', args: ['-NoProfile', '-Command', script] };
  }

  return null;
}

/**
 * Decide whether a hook event should fire a notification, tracking which
 * sessions have already been alerted for the current idle period in `notified`
 * (mutated in place). Returns the kind to fire, or null to stay silent.
 *
 * Decoupled from `PtySession.idle` so it does not depend on that field's
 * initial value: a session's first `stop`/`notification` still alerts, while
 * repeated `stop` events within one idle period are de-duplicated. A
 * `prompt_submit` (the user replied / a new turn started) clears the session
 * so the next idle alerts again.
 */
export function notifyKindForEvent(
  event: 'stop' | 'notification' | 'prompt_submit',
  sessionKey: string,
  notified: Set<string>,
): NotifyKind | null {
  if (event === 'prompt_submit') {
    notified.delete(sessionKey);
    return null;
  }
  if (notified.has(sessionKey)) return null;
  notified.add(sessionKey);
  return event === 'notification' ? 'needs_input' : 'idle';
}

export interface NotifyOptions {
  /** Notifications only fire when this is explicitly true. */
  enabled?: boolean;
  /** Override the detected platform (testing). */
  platform?: NodeJS.Platform;
  /** Override the spawn function (testing). */
  spawnFn?: typeof spawn;
}

/**
 * Fire a desktop notification for a session event. No-op when disabled, on an
 * unsupported platform, or when the notifier binary is missing. Never throws.
 */
export function notifyDesktop(
  sessionName: string,
  kind: NotifyKind,
  opts: NotifyOptions = {},
): void {
  if (opts.enabled !== true) return;

  const platform = opts.platform ?? process.platform;
  const command = buildNotifyCommand(sessionName, kind, platform);
  if (!command) return;

  const spawnFn = opts.spawnFn ?? spawn;
  try {
    const child = spawnFn(command.cmd, command.args, {
      detached: true,
      stdio: 'ignore',
    });
    // Swallow async spawn errors (e.g. ENOENT when the binary is absent);
    // without a handler these would surface as an uncaught exception.
    child.on?.('error', () => {});
    child.unref?.();
  } catch {
    /* notifier unavailable — silent no-op */
  }
}
