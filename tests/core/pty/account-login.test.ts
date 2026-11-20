import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountLoginDir, accountLoginSpec } from '../../../src/core/pty/account-login.js';
import { accountLoginId, accountOfLoginId, isAccountLoginId } from '../../../src/core/pty/account-login-id.js';
import { AccountAdminError, type AgentAccounts } from '../../../src/core/agents/index.js';
import { loginLaunch } from '../../../src/core/agents/claude/account-admin.js';
import { saveConfig } from '../../../src/core/platform/config.js';

/** The Accounts page's login terminal: its id, and the spec the PTY host starts it with (account-login.ts). */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-login-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const SKIP = /dangerously|skip-permissions|bypass/i;

describe('account login ids', () => {
  it("name the account, and nothing else reads as one (a session's id, the assistant's)", () => {
    expect(accountLoginId('work')).toBe('account-login:work');
    expect(accountOfLoginId('account-login:work')).toBe('work');
    expect(isAccountLoginId('account-login:work')).toBe(true);
    expect(accountOfLoginId('account-login:')).toBeNull();
    expect(isAccountLoginId('assistant')).toBe(false);
    expect(isAccountLoginId('0123456789ab')).toBe(false);
  });
});

describe('accountLoginSpec', () => {
  const tool = { cmd: 'claude', baseArgs: ['--model', 'opus'], resumeFlag: '--continue', promptFileFlag: '', promptFlag: '' };
  const accounts = (
    has: boolean,
    loginLaunch: () => { tool: typeof tool; agentEnv: Record<string, string | null> } = () => ({
      tool,
      agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' },
    }),
  ) =>
    ({
      has: () => has,
      admin: { loginLaunch } as unknown as NonNullable<AgentAccounts['admin']>,
    }) satisfies Pick<AgentAccounts, 'has' | 'admin'>;

  it("runs the agent's own CLI on the account, fresh, in work's own folder (made), with the account's environment", () => {
    const dir = path.join(home, 'login');
    const spec = accountLoginSpec('work', accounts(true), dir);
    expect(spec).toEqual({ cwd: dir, tool, fresh: true, agentEnv: { CLAUDE_CONFIG_DIR: '/acc/work' } });
    expect(fs.existsSync(dir)).toBe(true);
    expect([spec.tool.cmd, ...spec.tool.baseArgs].join(' ')).not.toMatch(SKIP);
  });

  it('an empty environment change is left out; unknown accounts and unmanaged agents are refused', () => {
    const none = accounts(
      true,
      vi.fn(() => ({ tool, agentEnv: {} })),
    );
    expect(accountLoginSpec('default', none, path.join(home, 'l')).agentEnv).toBeUndefined();
    expect(() => accountLoginSpec('nope', accounts(false), path.join(home, 'l'))).toThrow(AccountAdminError);
    expect(() => accountLoginSpec('work', undefined)).toThrow('not managed by work');
    expect(() => accountLoginSpec('work', { has: () => true }, path.join(home, 'l'))).toThrow('not managed by work');
  });

  it("lives under work's own folder", () => {
    expect(accountLoginDir()).toBe(path.join(home, '.work', 'account-login'));
  });
});

describe("Claude's loginLaunch", () => {
  it('claude (the configured command when it is Claude) on the account folder, in its normal permission mode', () => {
    const work = path.join(home, '.claude-work');
    saveConfig({
      worktreesRoot: path.join(home, 'wt'),
      repos: {},
      groups: {},
      claudeAccounts: { work },
      aiCommand: 'claude --model opus',
    } as never);
    const l = loginLaunch('work');
    expect(l.tool.cmd).toBe('claude');
    expect(l.tool.baseArgs).toEqual(['--model', 'opus']);
    expect(l.agentEnv).toEqual({ CLAUDE_CONFIG_DIR: work });
    expect(l.tool.baseArgs.join(' ')).not.toMatch(SKIP);
    // The default account, once others exist: the variable taken out, so an inherited one never sends it elsewhere.
    expect(loginLaunch('default').agentEnv).toEqual({ CLAUDE_CONFIG_DIR: null });
    expect(() => loginLaunch('nope')).toThrow(AccountAdminError);
  });

  it('another agent configured: plain claude', () => {
    saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: {}, groups: {}, aiCommand: 'opencode' } as never);
    expect(loginLaunch('default').tool.cmd).toBe('claude');
  });
});
