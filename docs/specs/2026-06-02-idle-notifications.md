# Spec: Idle / needs-input desktop notifications

**Date:** 2026-06-02
**Slug:** idle-notifications
**Scope classification:** small feature (4 files; 1 new core module + 1 new test)
**Security impact:** low — spawns a local notifier subprocess with session-derived strings; mitigated by `cross-spawn` argv arrays and AppleScript string escaping.

## Problem

When running multiple parallel agent sessions in `work dash`, a user must watch the TUI to notice when a session goes idle (Claude finished its turn — `Stop`) or needs input (`Notification`). The whole value of parallel agents is reclaiming that wait-time. The dashboard's `HookServer` (`src/core/hook-server.ts`) already receives these events; today it only flips an in-TUI idle indicator (`pty.setIdle`).

## Goal

Surface idle / needs-input events as **desktop OS notifications**, opt-in via config, cross-platform, with a graceful no-op when the notifier binary is absent.

## Design

### 1. New core module `src/core/notifier.ts`
- `export type NotifyKind = 'idle' | 'needs_input';`
- `export function buildNotifyCommand(sessionName, kind, platform): { cmd: string; args: string[] } | null` — **pure**, testable; null = unsupported platform.
  - **darwin:** `osascript -e '<applescript>'`, AppleScript = `display notification "<msg>" with title "<title>"`. Title/message sanitized (strip control chars; escape `\` then `"`) before embedding, since osascript parses the `-e` arg as a script.
  - **linux:** `notify-send <title> <msg>` (title/message as separate argv args — injection-safe).
  - **win32:** `powershell -NoProfile -Command <script>` toast; strings escaped for single-quoted PowerShell literals.
  - other platforms: `null`.
  - Title: `work: <sessionName>`. Message: `Idle — finished its turn` (idle) / `Needs your input` (needs_input).
- `export function notifyDesktop(sessionName, kind, opts?: { enabled?: boolean; platform?: NodeJS.Platform; spawnFn?: typeof spawn }): void`
  - Fire-and-forget; never throws. No-op when `opts.enabled !== true`.
  - Calls `buildNotifyCommand`; if null, no-op. Else spawns via `cross-spawn` argv array, `{ detached: true, stdio: 'ignore' }`, `child.unref()`, wrapped in try/catch so a missing binary (ENOENT) is a silent no-op.
  - `platform`/`spawnFn` injectable for tests (defaults: `process.platform`, `cross-spawn`).

### 2. Config flag — `src/core/config.ts`
- Add `notifications?: boolean;` to `WorkConfig` (opt-in; absent/false ⇒ disabled).
- Parse in `loadConfig()`: `notifications: parsed.notifications`.

### 3. Wire into the dashboard hook callback — `src/tui-ink/App.tsx`
- In the existing `HookServer` callback (~line 448), for `stop`/`notification`, capture `pty.idle` **before** `setIdle(true)`; only on the transition (`!wasIdle`) call
  `notifyDesktop(path.basename(cwd), event === 'notification' ? 'needs_input' : 'idle', { enabled: config?.notifications === true })`.
- `config` already in scope (`const [config] = useState(() => loadConfig())`). Transition-only guard avoids duplicate-`Stop` spam.
- `work web` does **not** mount a HookServer (confirmed: only App.tsx does), so notifications attach to `work dash`.

### 4. Tests — `tests/core/notifier.test.ts`
- `buildNotifyCommand` per platform (darwin/linux/win32 shape; unsupported→null).
- AppleScript escaping: session name with `"` / `\` / control chars stays inside the script string.
- `notifyDesktop` no-op (spawnFn not called) when `enabled` falsy.
- `notifyDesktop` calls injected `spawnFn` with expected argv when enabled.
- `notifyDesktop` swallows a throwing `spawnFn`.

## Change manifest
1. `src/core/notifier.ts` (new)
2. `src/core/config.ts` (add field + parse)
3. `src/tui-ink/App.tsx` (wire callback, transition-only)
4. `tests/core/notifier.test.ts` (new)

## Test manifest
- `tests/core/notifier.test.ts` — command building, escaping, enabled/disabled no-op, error-swallow.

## Public contracts added
- `notifyDesktop`, `buildNotifyCommand`, `NotifyKind` in `src/core/notifier.ts`.
- `WorkConfig.notifications?: boolean`.

## Out of scope
- `work web` browser notifications (no HookServer there yet).
- Slack/ntfy/webhook transports.
- Suppressing notifications for the currently-focused session (follow-up).
- `work.ps1` (no dash/hook in the PowerShell port).
- A `work config` subcommand to toggle the flag (edit config.json / `work config edit`).

## Assumptions & risks
- Session name = worktree dir basename (consistent with the tool's session labels).
- osascript `-e` injection is the only real security surface; mitigated by escaping. `notify-send`/PowerShell use separate args / escaped literals.
- Spawn must never block the TUI or throw — detached + ignored stdio + try/catch.
