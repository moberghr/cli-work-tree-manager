import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySetupCopy,
  globalConfigFile,
  marketplaceAddArgs,
  mergeSettings,
  planSetupCopy,
  setupEnv,
  setupSummary,
  type SetupRun,
} from '../../../../src/core/agents/claude/setup-copy.js';

/** Copy one Claude account's setup to another (reported: a second account starts empty, so a session moved to it lost its tools). */
let home: string;
let from: { name: string; dir: string };
let to: { name: string; dir: string };
const write = (file: string, content: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-copy-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  from = { name: 'default', dir: path.join(home, '.claude') };
  to = { name: 'admin', dir: path.join(home, '.claude-admin') };
  write(path.join(from.dir, 'CLAUDE.md'), '# mine\n');
  write(path.join(from.dir, 'agents', 'reviewer.md'), 'agent');
  write(path.join(from.dir, 'commands', 'open.md'), 'cmd');
  write(path.join(from.dir, 'skills', 'grill-me', 'SKILL.md'), 'skill');
  write(path.join(from.dir, 'skills', 'synced', 'x', 'SKILL.md'), 'claude code’s own');
  write(path.join(from.dir, '.credentials.json'), { secret: 'NEVER' });
  write(path.join(from.dir, 'history.jsonl'), 'history');
  write(path.join(from.dir, 'settings.json'), {
    permissions: { allow: ['Bash(git:*)'], deny: ['Read(**/prod.json)'], defaultMode: 'acceptEdits' },
    enabledPlugins: { 'ts@official': true, 'off@official': false },
    statusLine: { type: 'command', command: 'from' },
    hooks: {
      Notification: [
        { hooks: [{ type: 'command', command: 'notify-me' }] },
        { hooks: [{ type: 'command', command: 'work hook x' }], _workHookOwner: 'web' },
      ],
    },
    effortLevel: 'high',
  });
  write(path.join(from.dir, 'plugins', 'known_marketplaces.json'), {
    official: { source: { source: 'github', repo: 'anthropics/official' } },
    team: { source: { source: 'github', repo: 'me/team', sparsePaths: ['.claude-plugin'] } },
  });
  write(path.join(home, '.claude.json'), {
    userID: 'A',
    mcpServers: {
      atlassian: { type: 'http', url: 'https://mcp.example/v2' },
      local: { command: 'node', args: ['x.js'], env: { KEY: 'k' } },
    },
  });
  write(path.join(to.dir, 'settings.json'), {
    theme: 'dark',
    permissions: { allow: ['Bash(npm:*)'] },
    statusLine: { type: 'command', command: 'to' },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'work hook y' }], _workHookOwner: 'web' }] },
  });
  write(path.join(to.dir, 'plugins', 'known_marketplaces.json'), {
    official: { source: { source: 'github', repo: 'anthropics/official' } },
  });
  write(path.join(to.dir, '.claude.json'), { userID: 'B', mcpServers: { local: { command: 'old' } } });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('mergeSettings', () => {
  it('joins the rules, adds the source’s plugins, takes your own hooks, and leaves the status line and work’s hooks alone', () => {
    const merged = mergeSettings(read(path.join(from.dir, 'settings.json')), read(path.join(to.dir, 'settings.json')));
    expect(merged.permissions).toEqual({ allow: ['Bash(npm:*)', 'Bash(git:*)'], deny: ['Read(**/prod.json)'], defaultMode: 'acceptEdits' });
    expect(merged.enabledPlugins).toEqual({ 'ts@official': true, 'off@official': false });
    expect(merged.statusLine).toEqual({ type: 'command', command: 'to' });
    expect(merged.theme).toBe('dark');
    expect(merged.effortLevel).toBe('high');
    expect(merged.hooks).toEqual({
      Stop: [{ hooks: [{ type: 'command', command: 'work hook y' }], _workHookOwner: 'web' }],
      Notification: [{ hooks: [{ type: 'command', command: 'notify-me' }] }],
    });
  });

  it('merged twice is the same as once (a hook or a rule isn’t added again)', () => {
    const source = read(path.join(from.dir, 'settings.json'));
    const once = mergeSettings(source, read(path.join(to.dir, 'settings.json')));
    expect(mergeSettings(source, once)).toEqual(once);
  });
});

describe('where things are', () => {
  it('the default folder’s global config is beside it; another account’s is inside its folder', () => {
    expect(globalConfigFile(from.dir)).toBe(path.join(home, '.claude.json'));
    expect(globalConfigFile(to.dir)).toBe(path.join(to.dir, '.claude.json'));
    expect(setupEnv(from.dir)).toEqual({ CLAUDE_CONFIG_DIR: null });
    expect(setupEnv(to.dir)).toEqual({ CLAUDE_CONFIG_DIR: to.dir });
  });

  it('a marketplace is added from its repo, folder or URL, with its sparse paths; never a source that reads as an option', () => {
    expect(marketplaceAddArgs({ source: 'github', repo: 'me/team', sparsePaths: ['.claude-plugin'] })).toEqual([
      'plugin',
      'marketplace',
      'add',
      'me/team',
      '--scope',
      'user',
      '--sparse',
      '.claude-plugin',
    ]);
    expect(marketplaceAddArgs({ source: 'directory', path: 'C:/m' })?.[3]).toBe('C:/m');
    expect(marketplaceAddArgs({ source: 'github', repo: '--help' })).toBeNull();
    expect(marketplaceAddArgs({ source: 'npm', package: 'x' })).toBeNull();
    expect(marketplaceAddArgs(null)).toBeNull();
  });
});

describe('planSetupCopy', () => {
  it('lists what the target lacks or has differently, and nothing of logins, history or Claude Code’s own skills', () => {
    const plan = planSetupCopy(from, to).map((i) => `${i.does} ${i.kind} ${i.name}`);
    expect(plan).toEqual([
      'adds file CLAUDE.md',
      'adds folder agents/',
      'adds folder commands/',
      'adds folder skills/grill-me/',
      'merges into settings settings.json',
      'adds mcp atlassian',
      'replaces mcp local',
      'adds marketplace team',
      'adds plugin ts@official',
    ]);
    expect(JSON.stringify(planSetupCopy(from, to))).not.toMatch(/credentials|history|synced|NEVER/);
    // A remote server says it needs its own sign-in there; a plugin switched off isn't installed.
    expect(planSetupCopy(from, to).find((i) => i.name === 'atlassian')?.note).toContain('needs its own sign-in on admin');
    expect(plan).not.toContain('adds plugin off@official');
  });
});

describe('applySetupCopy', () => {
  it('copies the files, merges the settings, and has Claude Code add servers, marketplaces and plugins as the target account', async () => {
    const calls: Array<{ args: string[]; env: unknown; input?: string }> = [];
    const run: SetupRun = (args, env, input) => (
      calls.push({ args, env, ...(input !== undefined ? { input } : {}) }),
      { ok: true, out: '' }
    );
    const done = await applySetupCopy(from, to, run);
    expect(done.every((r) => r.ok)).toBe(true);
    expect(fs.readFileSync(path.join(to.dir, 'CLAUDE.md'), 'utf-8')).toBe('# mine\n');
    expect(fs.existsSync(path.join(to.dir, 'agents', 'reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(to.dir, 'skills', 'grill-me', 'SKILL.md'))).toBe(true);
    // Never: a login, history, Claude Code's own skills. The target's own state is as it was.
    expect(fs.existsSync(path.join(to.dir, '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(to.dir, 'history.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(to.dir, 'skills', 'synced'))).toBe(false);
    expect(read(path.join(to.dir, '.claude.json')).userID).toBe('B');
    expect(read(path.join(to.dir, 'settings.json'))).toMatchObject({ theme: 'dark', effortLevel: 'high', statusLine: { command: 'to' } });

    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'mcp add-json atlassian - --scope user',
      'mcp remove local --scope user',
      'mcp add-json local - --scope user',
      'plugin marketplace add me/team --scope user --sparse .claude-plugin',
      'plugin install ts@official --scope user -y',
    ]);
    // As the target account, and a server's definition (which may hold a key) on stdin, never on the command line.
    expect(calls.every((c) => JSON.stringify(c.env) === JSON.stringify({ CLAUDE_CONFIG_DIR: to.dir }))).toBe(true);
    expect(calls[2].input).toBe(JSON.stringify({ command: 'node', args: ['x.js'], env: { KEY: 'k' } }));
    expect(calls.map((c) => c.args.join(' ')).join(' ')).not.toContain('KEY');
    expect(setupSummary(done, 'default', 'admin')).toBe('Copied 9 of 9 things from default to admin.');
  });

  it('one that fails is said with Claude Code’s last line, and the rest still go', async () => {
    const run: SetupRun = (args) =>
      args[0] === 'plugin' && args[1] === 'install' ? { ok: false, out: 'working…\nmarketplace not found\n' } : { ok: true, out: '' };
    const done = await applySetupCopy(from, to, run);
    expect(done.filter((r) => !r.ok)).toEqual([expect.objectContaining({ name: 'ts@official', error: 'marketplace not found' })]);
    expect(setupSummary(done, 'default', 'admin')).toBe('Copied 8 of 9 things from default to admin; 1 failed.');
  });

  it('an account is never copied to itself; an account set up the same has nothing to copy', async () => {
    await expect(applySetupCopy(from, { name: 'same', dir: from.dir })).rejects.toThrow('can’t be copied to itself');
    expect(setupSummary([], 'default', 'admin')).toBe("admin already has default's setup: nothing to copy.");
  });
});
