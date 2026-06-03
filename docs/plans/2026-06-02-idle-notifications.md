# Plan: Idle / needs-input desktop notifications

Spec: `docs/specs/2026-06-02-idle-notifications.md`

## Approach

Add a small, self-contained `notifier` core module that converts a session name + event kind into a platform-appropriate desktop notification, spawned fire-and-forget. Gate it behind a new opt-in `WorkConfig.notifications` flag. Wire it into the one place that already receives Claude's lifecycle hook events — the `work dash` `HookServer` callback — firing only on the transition to idle/needs-input.

## Batches

### Batch 1 — notifier module + config + tests
- `src/core/notifier.ts`: `NotifyKind`, pure `buildNotifyCommand(name, kind, platform)`, `notifyDesktop(name, kind, opts?)` (cross-spawn argv, detached, stdio ignore, try/catch, no-op when disabled/unsupported).
- `src/core/config.ts`: add `notifications?: boolean` to `WorkConfig` + parse in `loadConfig`.
- `tests/core/notifier.test.ts`: command-shape per platform, AppleScript escaping, enabled/disabled no-op, error-swallow.
- Checkpoint: `npx tsc --noEmit` + `npm test`.

### Batch 2 — wire into dash
- `src/tui-ink/App.tsx`: in the HookServer callback, transition-only `notifyDesktop(path.basename(cwd), kind, { enabled: config?.notifications === true })`.
- Checkpoint: `npx tsc --noEmit` + `npm run build` + `npm test`.

## Verification
- Unit tests cover the pure builder and the spawn wrapper (injected spawnFn) — no real notifications fired in CI.
- Manual smoke (optional, macOS): set `"notifications": true` in `~/.work/config.json`, run `work dash`, let a session go idle → expect a banner.

## Risks / mitigations
- **Command injection via osascript `-e`** → escape `\` and `"`, strip control chars; `notify-send`/PowerShell use separate/escaped args. (security-and-hardening)
- **Spawn blocking/throwing in the TUI** → detached, `stdio:'ignore'`, `unref()`, try/catch.
- **Notification spam** → fire only on `!wasIdle` transition.
- **§0.4 / §1.1**: use `cross-spawn` argv arrays, never a shell string.
