import { describe, it, expect, vi } from 'vitest';
import {
  buildNotifyCommand,
  notifyDesktop,
  notifyKindForEvent,
} from '../../src/core/notifier.js';

describe('buildNotifyCommand', () => {
  it('builds an osascript command on darwin', () => {
    const cmd = buildNotifyCommand('feature-login', 'idle', 'darwin');
    expect(cmd?.cmd).toBe('osascript');
    expect(cmd?.args[0]).toBe('-e');
    expect(cmd?.args[1]).toBe(
      'display notification "Idle — finished its turn" with title "work: feature-login"',
    );
  });

  it('uses the needs-input message for notification events', () => {
    const cmd = buildNotifyCommand('api', 'needs_input', 'darwin');
    expect(cmd?.args[1]).toContain('display notification "Needs your input"');
  });

  it('builds a notify-send command with separate args on linux', () => {
    const cmd = buildNotifyCommand('feature-login', 'idle', 'linux');
    expect(cmd).toEqual({
      cmd: 'notify-send',
      args: ['work: feature-login', 'Idle — finished its turn'],
    });
  });

  it('builds a powershell command on win32', () => {
    const cmd = buildNotifyCommand('feature-login', 'idle', 'win32');
    expect(cmd?.cmd).toBe('powershell');
    expect(cmd?.args).toContain('-NoProfile');
    expect(cmd?.args.join(' ')).toContain('ShowBalloonTip');
  });

  it('returns null for unsupported platforms', () => {
    expect(buildNotifyCommand('x', 'idle', 'aix')).toBeNull();
    expect(buildNotifyCommand('x', 'idle', 'freebsd')).toBeNull();
  });

  it('escapes double-quotes and backslashes so they cannot break the AppleScript string', () => {
    const cmd = buildNotifyCommand('weird"name\\here', 'idle', 'darwin');
    const script = cmd!.args[1];
    // The injected name must appear escaped, not as a raw closing quote.
    expect(script).toContain('with title "work: weird\\"name\\\\here"');
    // No unescaped quote should prematurely close the title literal.
    expect(script.endsWith('"')).toBe(true);
  });

  it('strips control characters (incl. DEL) from the session name', () => {
    const cmd = buildNotifyCommand('a\tb\nc\x7fd', 'idle', 'linux');
    expect(cmd?.args[0]).toBe('work: a b c d');
  });

  it('strips control characters on the darwin path too', () => {
    const cmd = buildNotifyCommand('bad\nname', 'idle', 'darwin');
    expect(cmd?.args[1]).not.toContain('\n');
    expect(cmd?.args[1]).toContain('work: bad name');
  });

  it('strips control characters on the win32 path too', () => {
    const cmd = buildNotifyCommand('bad\nname', 'idle', 'win32');
    expect(cmd?.args.join(' ')).not.toContain('\n');
    expect(cmd?.args.join(' ')).toContain('work: bad name');
  });

  it("doubles single quotes for the PowerShell literal", () => {
    const cmd = buildNotifyCommand("o'brien", 'idle', 'win32');
    expect(cmd?.args.join(' ')).toContain("work: o''brien");
  });
});

describe('notifyKindForEvent', () => {
  it('fires on the first stop even when no prompt_submit preceded it', () => {
    const notified = new Set<string>();
    expect(notifyKindForEvent('stop', 'k', notified)).toBe('idle');
  });

  it('maps a notification event to needs_input', () => {
    expect(notifyKindForEvent('notification', 'k', new Set())).toBe('needs_input');
  });

  it('de-dupes repeated stops within one idle period', () => {
    const notified = new Set<string>();
    expect(notifyKindForEvent('stop', 'k', notified)).toBe('idle');
    expect(notifyKindForEvent('stop', 'k', notified)).toBeNull();
    expect(notifyKindForEvent('notification', 'k', notified)).toBeNull();
  });

  it('re-arms after prompt_submit (new turn)', () => {
    const notified = new Set<string>();
    notifyKindForEvent('stop', 'k', notified);
    expect(notifyKindForEvent('prompt_submit', 'k', notified)).toBeNull();
    expect(notifyKindForEvent('stop', 'k', notified)).toBe('idle');
  });

  it('tracks sessions independently', () => {
    const notified = new Set<string>();
    expect(notifyKindForEvent('stop', 'a', notified)).toBe('idle');
    expect(notifyKindForEvent('stop', 'b', notified)).toBe('idle');
    expect(notifyKindForEvent('stop', 'a', notified)).toBeNull();
  });

  it('re-arms for needs_input after prompt_submit', () => {
    const notified = new Set<string>();
    notifyKindForEvent('notification', 'k', notified);
    notifyKindForEvent('prompt_submit', 'k', notified);
    expect(notifyKindForEvent('notification', 'k', notified)).toBe('needs_input');
  });

  it('suppresses a stop after a notification already alerted the same period', () => {
    const notified = new Set<string>();
    expect(notifyKindForEvent('notification', 'k', notified)).toBe('needs_input');
    expect(notifyKindForEvent('stop', 'k', notified)).toBeNull();
  });

  it('prompt_submit on a never-alerted session is a safe no-op', () => {
    expect(notifyKindForEvent('prompt_submit', 'k', new Set())).toBeNull();
  });
});

describe('notifyDesktop', () => {
  it('is a no-op when not enabled (spawnFn never called)', () => {
    const spawnFn = vi.fn();
    notifyDesktop('s', 'idle', { platform: 'darwin', spawnFn: spawnFn as never });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('is a no-op on an unsupported platform even when enabled', () => {
    const spawnFn = vi.fn();
    notifyDesktop('s', 'idle', {
      enabled: true,
      platform: 'aix',
      spawnFn: spawnFn as never,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns the notifier with the expected argv when enabled', () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawnFn = vi.fn(() => child);
    notifyDesktop('feature-login', 'idle', {
      enabled: true,
      platform: 'linux',
      spawnFn: spawnFn as never,
    });
    expect(spawnFn).toHaveBeenCalledWith(
      'notify-send',
      ['work: feature-login', 'Idle — finished its turn'],
      { detached: true, stdio: 'ignore' },
    );
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
    // The registered async error handler must not throw (swallows ENOENT).
    const handler = child.on.mock.calls[0][1] as () => void;
    expect(() => handler()).not.toThrow();
  });

  it('swallows a throwing spawnFn (never throws to caller)', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(() =>
      notifyDesktop('s', 'idle', {
        enabled: true,
        platform: 'linux',
        spawnFn: spawnFn as never,
      }),
    ).not.toThrow();
  });
});
