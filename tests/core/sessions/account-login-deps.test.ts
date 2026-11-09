import { describe, expect, it, vi } from 'vitest';

/** The real wiring behind the Accounts page's login terminals (account-login-deps.ts), with the PTY host and the child faked. */

const pool = vi.hoisted(() => ({ start: vi.fn(async (n: string) => `account-login:${n}`), stop: vi.fn(async () => {}) }));
vi.mock('../../../src/core/pty/pty-pool.js', () => ({ startAccountLogin: pool.start, stopAccountLogin: pool.stop }));
const child = vi.hoisted(() => vi.fn());
vi.mock('../../../src/core/worktree/setup-child.js', () => ({ runWorkChild: child }));
const agent = vi.hoisted(() => ({ has: (n: string) => n === 'work' }));
vi.mock('../../../src/core/agents/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/agents/index.js')>()),
  agentFor: () => ({ accounts: { has: agent.has } }),
}));

const { defaultAccountLogins } = await import('../../../src/core/sessions/account-login-deps.js');
const { createActivityLog } = await import('../../../src/core/platform/activity.js');

describe('defaultAccountLogins', () => {
  it("starts and stops the account's terminal in the PTY host, then installs work's skills in a `work account skills` child, noted in Activity", async () => {
    child.mockResolvedValue({ stdout: 'installed the Claude Code plugin\n', stderr: '', code: 0, timedOut: false });
    const activity = createActivityLog();
    const logins = defaultAccountLogins({ activity, workBin: () => '/w/dist/bin.js' });
    expect(await logins.start('work')).toBe('account-login:work');
    await expect(logins.start('nope')).rejects.toThrow('no account');
    const { skills } = await logins.stop('work');
    expect(pool.stop).toHaveBeenCalledWith('work');
    expect(await skills).toEqual({ ok: true, message: 'installed the Claude Code plugin' });
    expect(child).toHaveBeenCalledWith('/w/dist/bin.js', ['account', 'skills', 'work'], expect.anything());
    expect(activity.snapshot().recent[0]).toMatchObject({ kind: 'accounts', status: 'done' });
  });
});
