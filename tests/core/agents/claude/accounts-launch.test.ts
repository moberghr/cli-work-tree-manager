import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountEnv } from '../../../../src/core/agents/claude/accounts.js';
import { claudeAgent } from '../../../../src/core/agents/claude/adapter.js';
import {
  encodeProjectDir,
  getClaudeActivityMs,
  hasClaudeConversation,
  resolveResumeLaunch,
} from '../../../../src/core/agents/claude/activity.js';
import { internalClaudeSpawn } from '../../../../src/core/agents/claude/internal.js';
import { getConfigPath } from '../../../../src/core/platform/config.js';
import type { WorktreeSession } from '../../../../src/core/sessions/history.js';

/** Launching a Claude on a session's account: the environment it starts with, and where its conversations are looked for. */

let home: string;
let work: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-launch-'));
  work = path.join(home, '.claude-work');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const writeConfig = (extra: Record<string, unknown> = {}) => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify({ worktreesRoot: '/wt', repos: {}, groups: {}, copyFiles: [], ...extra }));
};
const withAccounts = (extra: Record<string, unknown> = {}) => writeConfig({ claudeAccounts: { work }, ...extra });

/** A transcript for `cwd` under a config folder's projects. */
function transcript(configDir: string, cwd: string): void {
  const dir = path.join(configDir, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n');
}
const session = (paths: string[], account?: string): WorktreeSession =>
  ({
    target: 't',
    branch: 'b',
    isGroup: false,
    paths,
    createdAt: '',
    lastAccessedAt: '',
    ...(account ? { account } : {}),
  }) as WorktreeSession;

describe('the environment of an account', () => {
  it('a configured account sets CLAUDE_CONFIG_DIR; the default takes it out once accounts exist, so no inherited one wins', () => {
    withAccounts();
    expect(accountEnv('work')).toEqual({ CLAUDE_CONFIG_DIR: work });
    expect(accountEnv('default')).toEqual({ CLAUDE_CONFIG_DIR: null });
    expect(accountEnv('gone')).toEqual({ CLAUDE_CONFIG_DIR: null }); // not an account any more: the default's folder, never a stray one
  });

  it('with no accounts configured nothing changes: a CLAUDE_CONFIG_DIR the user sets themselves stays', () => {
    writeConfig();
    expect(accountEnv('default')).toEqual({});
    expect(claudeAgent.launch.env?.({ account: undefined })).toEqual({});
  });

  it("the adapter reads a session's recorded account; work's own runs (null) use the configured default", () => {
    withAccounts({ claudeAccount: 'work' });
    expect(claudeAgent.launch.env?.({ account: 'work' })).toEqual({ CLAUDE_CONFIG_DIR: work });
    expect(claudeAgent.launch.env?.({ account: 'default' })).toEqual({ CLAUDE_CONFIG_DIR: null });
    expect(claudeAgent.launch.env?.({})).toEqual({ CLAUDE_CONFIG_DIR: null }); // a row from before: the default account
    expect(claudeAgent.launch.env?.(null)).toEqual({ CLAUDE_CONFIG_DIR: work });
  });

  it('an internal one-shot run is on the configured default account, over an inherited folder', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/inherited');
    withAccounts({ claudeAccount: 'work' });
    expect(internalClaudeSpawn().env.CLAUDE_CONFIG_DIR).toBe(work);
    expect(claudeAgent.oneShot?.command({}).env.CLAUDE_CONFIG_DIR).toBe(work);
    withAccounts({ claudeAccount: 'default' });
    expect(internalClaudeSpawn().env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(internalClaudeSpawn().env.WORK_INTERNAL_CLAUDE).toBeDefined(); // the marker still rides along
  });
});

describe("the resume gate looks in the account's folder", () => {
  it('activity and hasClaudeConversation read <config dir>/projects, ~/.claude by default', () => {
    const cwd = path.join(home, 'wt', 'api');
    transcript(work, cwd);
    expect(hasClaudeConversation(cwd)).toBe(false);
    expect(getClaudeActivityMs(cwd)).toBe(0);
    expect(hasClaudeConversation(cwd, work)).toBe(true);
    expect(getClaudeActivityMs(cwd, work)).toBeGreaterThan(0);
    const other = path.join(home, 'wt', 'other');
    transcript(path.join(home, '.claude'), other);
    expect(hasClaudeConversation(other)).toBe(true);
    expect(hasClaudeConversation(other, work)).toBe(false);
  });

  it("canResume asks the session's account, or the environment it will start with (that wins)", () => {
    const cwd = path.join(home, 'wt', 'api');
    withAccounts();
    transcript(work, cwd);
    expect(claudeAgent.launch.canResume(cwd)).toBe(false);
    expect(claudeAgent.launch.canResume(cwd, { session: { account: 'work' } })).toBe(true);
    expect(claudeAgent.launch.canResume(cwd, { session: { account: 'default' } })).toBe(false);
    expect(claudeAgent.launch.canResume(cwd, { env: { CLAUDE_CONFIG_DIR: work } })).toBe(true);
    expect(claudeAgent.launch.canResume(cwd, { env: { PATH: '/bin' } })).toBe(false); // an environment with no folder: ~/.claude
    expect(claudeAgent.launch.canResume(cwd, { session: { account: 'work' }, env: { PATH: '/bin' } })).toBe(false);
  });

  it("resolveResumeLaunch finds a conversation only in the session's own account", () => {
    withAccounts();
    const repo = path.join(home, 'wt', 'api');
    fs.mkdirSync(repo, { recursive: true });
    transcript(work, repo);
    expect(resolveResumeLaunch(session([repo], 'work'))).toEqual({ launchPath: repo, hasConversation: true });
    expect(resolveResumeLaunch(session([repo], 'default')).hasConversation).toBe(false);
    expect(resolveResumeLaunch(session([repo])).hasConversation).toBe(false); // a row from before runs on ~/.claude
    expect(claudeAgent.launch.resumeLaunch(session([repo], 'work')).hasConversation).toBe(true);
    transcript(path.join(home, '.claude'), repo);
    expect(resolveResumeLaunch(session([repo])).hasConversation).toBe(true);
  });
});
