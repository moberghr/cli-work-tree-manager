import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/core/platform/process.js', async (orig) => ({
  ...(await orig<typeof import('../../../../src/core/platform/process.js')>()),
  processTable: vi.fn(() => new Map<number, string>()),
  bootTime: vi.fn(() => 1_000_000),
}));
import { processTable } from '../../../../src/core/platform/process.js';
import { claudeAccounts } from '../../../../src/core/agents/claude/accounts.js';
import { claudeAgent } from '../../../../src/core/agents/claude/adapter.js';
import {
  claudeProjectsRoots,
  encodeProjectDir,
  getClaudeActivityMs,
  hasClaudeConversation,
} from '../../../../src/core/agents/claude/activity.js';
import { latestTranscript, listTranscripts, listUsageFiles } from '../../../../src/core/agents/claude/files.js';
import { accountOf } from '../../../../src/core/agents/claude/rate-limits.js';
import { claudeSkillsWith } from '../../../../src/core/agents/claude/skills.js';
import { runStatusLineHook } from '../../../../src/core/agents/claude/statusline-hook.js';
import { originalStatusLine, savedPath } from '../../../../src/core/agents/claude/statusline-run.js';
import { claudeUsage } from '../../../../src/core/agents/claude/usage.js';
import { getConfigPath } from '../../../../src/core/platform/config.js';
import { buildUsage } from '../../../../src/core/usage/usage-source.js';
import { recordReading } from '../../../../src/core/usage/usage-store.js';
import type { WorktreeSession } from '../../../../src/core/sessions/history.js';

/** Claude accounts, the readers and installers that look across them (agents/claude/: transcripts, process files, settings, skills, usage names). */

let home: string;
let work: string;
let alt: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-readers-'));
  work = path.join(home, '.claude-work');
  alt = path.join(home, '.claude-alt');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.mocked(processTable).mockReturnValue(new Map());
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const writeConfig = (extra: Record<string, unknown> = {}) => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify({ worktreesRoot: '/wt', repos: {}, groups: {}, copyFiles: [], ...extra }));
};
/** Both accounts configured, their folders there (as `work account add` leaves them). */
const withAccounts = (extra: Record<string, unknown> = {}) => {
  for (const dir of [work, alt]) fs.mkdirSync(dir, { recursive: true });
  writeConfig({ claudeAccounts: { work, alt }, ...extra });
};

const cwdOf = (name: string) => path.join(home, 'wt', name);
function transcript(configDir: string, cwd: string, name = 'a.jsonl', body = '{}\n'): string {
  const dir = path.join(configDir, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}
const session = (cwd: string, account?: string): WorktreeSession =>
  ({
    target: 't',
    branch: 'b',
    isGroup: false,
    paths: [cwd],
    createdAt: '',
    lastAccessedAt: '',
    ...(account ? { account } : {}),
  }) as WorktreeSession;

describe('the accounts list is read from config only when the file changed', () => {
  it('follows a rewritten config, and is just the default with none', () => {
    expect(claudeAccounts().map((a) => a.name)).toEqual(['default']);
    withAccounts();
    expect(claudeAccounts().map((a) => a.name)).toEqual(['default', 'alt', 'work']);
    writeConfig({ claudeAccounts: { work } });
    expect(claudeAccounts().map((a) => a.name)).toEqual(['default', 'work']);
  });
});

describe('transcripts across accounts', () => {
  it("a session on a second account has its conversation found there, through the adapter's readers", () => {
    withAccounts();
    const cwd = cwdOf('api');
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello from work' }, timestamp: '2026-10-29T10:00:00Z' });
    const file = transcript(work, cwd, 'c1.jsonl', `${line}\n`);
    const s = session(cwd, 'work');
    expect(listTranscripts(s).map((t) => t.file)).toEqual([file]);
    expect(latestTranscript(s)?.file).toBe(file);
    expect(claudeAgent.conversation!.files(s).map((t) => t.file)).toEqual([file]);
    expect(claudeAgent.conversation!.read!(s, { last: 5 }).map((e) => e.text)).toEqual(['hello from work']);
    // Subagent files of that conversation count for the plan too.
    const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), '{}\n');
    expect(listUsageFiles(s).map((t) => path.basename(t.file))).toEqual(['c1.jsonl', 'agent-1.jsonl']);
  });

  it("looks in the session's own account first, then the others, each file once", () => {
    withAccounts();
    const cwd = cwdOf('api');
    const inDefault = transcript(path.join(home, '.claude'), cwd, 'd.jsonl');
    const inWork = transcript(work, cwd, 'w.jsonl');
    const inAlt = transcript(alt, cwd, 'x.jsonl');
    expect(listTranscripts(session(cwd, 'work')).map((t) => t.file)).toEqual([inWork, inDefault, inAlt]);
    expect(listTranscripts(session(cwd)).map((t) => t.file)).toEqual([inDefault, inAlt, inWork]); // no account recorded: the default's
    // An account whose folder is the default's folder is not read twice.
    writeConfig({ claudeAccounts: { same: path.join(home, '.claude') } });
    expect(listTranscripts(session(cwd, 'same')).map((t) => t.file)).toEqual([inDefault]);
  });

  it('with no accounts configured only ~/.claude is read, as before', () => {
    writeConfig();
    const cwd = cwdOf('api');
    const inDefault = transcript(path.join(home, '.claude'), cwd);
    transcript(work, cwd, 'other.jsonl'); // a folder nobody configured
    expect(listTranscripts(session(cwd)).map((t) => t.file)).toEqual([inDefault]);
    expect(claudeProjectsRoots()).toEqual([path.join(home, '.claude', 'projects')]);
  });

  it('activity without a config folder is the newest across every account; the resume gate stays on one folder', () => {
    withAccounts();
    const cwd = cwdOf('api');
    const old = transcript(path.join(home, '.claude'), cwd, 'old.jsonl');
    fs.utimesSync(old, 1_000, 1_000);
    const fresh = transcript(work, cwd, 'new.jsonl');
    fs.utimesSync(fresh, 5_000, 5_000);
    expect(getClaudeActivityMs(cwd)).toBe(5_000_000);
    expect(getClaudeActivityMs(cwd, path.join(home, '.claude'))).toBe(1_000_000);
    expect(claudeAgent.conversation!.lastWriteMs!(cwd)).toBe(5_000_000);
    // `--continue` finds only the folder it runs with: ~/.claude has a conversation here, alt has none.
    expect(hasClaudeConversation(cwd)).toBe(true);
    expect(hasClaudeConversation(cwd, alt)).toBe(false);
  });
});

describe('where the adapter watches and restores', () => {
  it('watches every account’s projects and sessions folders', () => {
    withAccounts();
    const roots = claudeAgent.activityRoots!();
    for (const dir of [path.join(home, '.claude'), work, alt]) {
      expect(roots).toContain(path.join(dir, 'projects'));
      expect(roots).toContain(path.join(dir, 'sessions'));
    }
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('with no accounts it watches the two folders it always did', () => {
    writeConfig();
    expect(claudeAgent.activityRoots!()).toEqual([path.join(home, '.claude', 'projects'), path.join(home, '.claude', 'sessions')]);
  });

  it("restores a conversation into its session's account's projects folder", () => {
    withAccounts();
    const cwd = cwdOf('api');
    expect(claudeAgent.conversation!.restoreDir!(session(cwd, 'work'))).toBe(path.join(work, 'projects', encodeProjectDir(cwd)));
    expect(claudeAgent.conversation!.restoreDir!(session(cwd))).toBe(path.join(home, '.claude', 'projects', encodeProjectDir(cwd)));
    const group = { ...session(path.join(cwd, 'api'), 'alt'), isGroup: true } as WorktreeSession;
    expect(claudeAgent.conversation!.restoreDir!(group)).toBe(path.join(alt, 'projects', encodeProjectDir(cwd)));
  });
});

describe('running Claudes of every account', () => {
  const processFile = (dir: string, pid: number, id: string) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sessions', `${pid}.json`),
      JSON.stringify({ pid, sessionId: id, cwd: '/wt/x', status: 'idle', startedAt: 2_000_000 }),
    );
  };

  it('reads the process files of every account’s sessions folder', async () => {
    const { readLiveClaudes } = await import('../../../../src/core/agents/claude/live.js');
    withAccounts();
    processFile(path.join(home, '.claude'), 11, 's11');
    processFile(work, 12, 's12');
    processFile(alt, 13, 's13');
    vi.mocked(processTable).mockReturnValue(
      new Map([
        [11, 'claude.exe'],
        [12, 'claude.exe'],
      ]),
    );
    expect(
      readLiveClaudes(undefined, 1)
        .map((c) => c.pid)
        .sort(),
    ).toEqual([11, 12]);
    // Through the adapter, against a process table the caller has.
    const table = new Map([
      [11, 'claude.exe'],
      [13, 'claude.exe'],
    ]);
    expect(
      claudeAgent
        .live!.running(table)
        .map((c) => c.pid)
        .sort(),
    ).toEqual([11, 13]);
  });
});

describe('hooks in every account’s settings', () => {
  const hooks = [{ owner: 'o', edge: 'turn-start' as const, command: 'work hook turn-start' }];
  const settings = (dir: string) => path.join(dir, 'settings.json');
  const read = (dir: string) =>
    JSON.parse(fs.readFileSync(settings(dir), 'utf-8')) as { hooks?: Record<string, unknown[]>; model?: string };

  it('installs into the default and each configured account, and removes from all of them', async () => {
    withAccounts();
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(settings(work), JSON.stringify({ model: 'opus' }));
    await claudeAgent.events!.install(hooks);
    for (const dir of [path.join(home, '.claude'), work, alt]) expect(read(dir).hooks!.UserPromptSubmit).toHaveLength(1);
    expect(read(work).model).toBe('opus'); // what was there stays
    claudeAgent.events!.removeSync(hooks);
    for (const dir of [path.join(home, '.claude'), work, alt]) expect(read(dir).hooks).toBeUndefined();
  });

  it('an account whose settings do not parse is left alone and the others still get their hooks', async () => {
    withAccounts();
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(settings(work), '{ broken');
    await claudeAgent.events!.install(hooks);
    expect(fs.readFileSync(settings(work), 'utf-8')).toBe('{ broken');
    expect(read(path.join(home, '.claude')).hooks!.UserPromptSubmit).toHaveLength(1);
    expect(read(alt).hooks!.UserPromptSubmit).toHaveLength(1);
  });

  it('a configured account whose folder is not there yet is skipped, not made: hooks, status line and skills (X3)', async () => {
    writeConfig({ claudeAccounts: { work, alt } });
    fs.mkdirSync(work, { recursive: true });
    await claudeAgent.events!.install(hooks);
    await claudeUsage.setup!({ enabled: true, lean: false });
    const installs: Array<Record<string, string | null> | undefined> = [];
    await claudeSkillsWith((args, env) => {
      if (args[1] === 'install') installs.push(env);
      return { ok: true, stdout: 'moberg-plugins' };
    }).install({ skillsDir: null });
    expect(read(work).hooks!.UserPromptSubmit).toHaveLength(1);
    expect(fs.existsSync(alt)).toBe(false);
    expect(installs.map((e) => e?.CLAUDE_CONFIG_DIR)).toEqual([null, work]);
    claudeAgent.events!.removeSync(hooks);
    expect(fs.existsSync(alt)).toBe(false);
    // Once it is there (`work account add`, or the user), the next install reaches it.
    fs.mkdirSync(alt);
    await claudeAgent.events!.install(hooks);
    expect(read(alt).hooks!.UserPromptSubmit).toHaveLength(1);
  });

  it('with no accounts only ~/.claude/settings.json is written', async () => {
    writeConfig();
    await claudeAgent.events!.install(hooks);
    expect(read(path.join(home, '.claude')).hooks!.UserPromptSubmit).toHaveLength(1);
    expect(fs.existsSync(settings(work))).toBe(false);
  });
});

describe('the status line per account', () => {
  const settings = (dir: string) => path.join(dir, 'settings.json');
  const statusLine = (dir: string) =>
    (JSON.parse(fs.readFileSync(settings(dir), 'utf-8')) as { statusLine?: { command?: string } }).statusLine;
  const writeSettings = (dir: string, s: unknown) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settings(dir), JSON.stringify(s));
  };

  async function run(env: NodeJS.ProcessEnv): Promise<string> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c));
    stdin.end(JSON.stringify({ cwd: os.tmpdir() }));
    await runStatusLineHook({ stdin, stdout, env });
    return Buffer.concat(chunks).toString('utf-8');
  }

  it('wraps each account’s settings with its own saved original, and the hook shows the one of the Claude that runs it', async () => {
    withAccounts();
    writeSettings(path.join(home, '.claude'), { statusLine: { type: 'command', command: 'echo default-line' } });
    writeSettings(work, { statusLine: { type: 'command', command: 'echo work-line' } });
    // alt has no settings and no status line.
    expect(await claudeUsage.setup!({ enabled: true, lean: false })).toBe('status line wrapped: it records the plan limits');
    expect(statusLine(path.join(home, '.claude'))!.command).toBe('work hook statusline || (echo default-line)');
    expect(statusLine(work)!.command).toBe('work hook statusline || (echo work-line)');
    expect(statusLine(alt)!.command).toBe('work hook statusline');

    // One saved file per account: the default keeps statusline.json.
    expect(path.basename(savedPath())).toBe('statusline.json');
    expect(path.basename(savedPath(work))).toBe(`statusline-${accountOf(work)}.json`);
    expect(path.basename(savedPath(path.join(home, '.claude')))).toBe('statusline.json');
    expect(originalStatusLine(undefined, work)).toEqual({ command: 'echo work-line' });
    expect(originalStatusLine()).toEqual({ command: 'echo default-line' });
    expect(originalStatusLine(undefined, alt)).toBeNull();

    // The hook picks the line from the CLAUDE_CONFIG_DIR of the Claude that runs it.
    expect((await run({ CLAUDE_CONFIG_DIR: work })).trim()).toBe('work-line');
    expect((await run({})).trim()).toBe('default-line');
    expect(await run({ CLAUDE_CONFIG_DIR: alt })).toBe('');
  });

  it('wrapping again keeps each account’s first original; restore gives every account its own back', async () => {
    withAccounts();
    writeSettings(path.join(home, '.claude'), { statusLine: { type: 'command', command: 'echo d' } });
    writeSettings(work, { statusLine: { type: 'command', command: 'echo w' } });
    await claudeUsage.setup!({ enabled: true, lean: false });
    await claudeUsage.setup!({ enabled: true, lean: false });
    expect(originalStatusLine(undefined, work)).toEqual({ command: 'echo w' });
    const r = await claudeUsage.restore!();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('work: ');
    expect(statusLine(path.join(home, '.claude'))).toEqual({ type: 'command', command: 'echo d' });
    expect(statusLine(work)).toEqual({ type: 'command', command: 'echo w' });
    expect(statusLine(alt)).toBeUndefined();
    expect(fs.existsSync(savedPath(work))).toBe(false);
  });

  it('an account whose settings are already ours but has nothing saved (copied from the default) runs the default’s original (X2)', async () => {
    withAccounts();
    writeSettings(path.join(home, '.claude'), { statusLine: { type: 'command', command: 'echo default-line' } });
    await claudeUsage.setup!({ enabled: true, lean: false });
    // alt's settings.json copied from the default's after the wrap: work's line, with nothing saved for alt.
    fs.rmSync(savedPath(alt), { force: true });
    fs.copyFileSync(settings(path.join(home, '.claude')), settings(alt));
    expect(fs.existsSync(savedPath(alt))).toBe(false);
    expect(originalStatusLine(undefined, alt)).toEqual({ command: 'echo default-line' });
    expect((await run({ CLAUDE_CONFIG_DIR: alt })).trim()).toBe('default-line');
    // Its own saved original, when there is one, still wins (an explicit "none" too).
    fs.writeFileSync(savedPath(alt), JSON.stringify({ original: null }));
    expect(originalStatusLine(undefined, alt)).toBeNull();
  });

  it('disabling gives every account’s line back', async () => {
    withAccounts();
    writeSettings(work, { statusLine: { type: 'command', command: 'echo w' } });
    await claudeUsage.setup!({ enabled: true, lean: false });
    expect(await claudeUsage.setup!({ enabled: false, lean: false })).toBe('status line given back (usage.statusLine is false)');
    expect(statusLine(work)).toEqual({ type: 'command', command: 'echo w' });
    expect(statusLine(alt)).toBeUndefined();
  });
});

describe('skills per account', () => {
  type Call = { args: string[]; env?: Record<string, string | null> };
  const recorder = () => {
    const calls: Call[] = [];
    const run = (args: string[], env?: Record<string, string | null>) => {
      calls.push({ args, env });
      // Registered and installed already for everyone: the shortest run.
      if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') return { ok: true, stdout: 'moberg-plugins' };
      return { ok: true, stdout: '' };
    };
    return { calls, run };
  };

  it('installs the plugin once per account, each with its own CLAUDE_CONFIG_DIR', async () => {
    withAccounts();
    const { calls, run } = recorder();
    const r = await claudeSkillsWith(run).install({ skillsDir: null });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('work: ');
    const installs = calls.filter((c) => c.args[1] === 'install');
    expect(installs.map((c) => c.env)).toEqual([{ CLAUDE_CONFIG_DIR: null }, { CLAUDE_CONFIG_DIR: alt }, { CLAUDE_CONFIG_DIR: work }]);
  });

  it('one account failing fails the whole, naming it, and the others are still done', async () => {
    withAccounts();
    const calls: Call[] = [];
    const run = (args: string[], env?: Record<string, string | null>) => {
      calls.push({ args, env });
      if (args[1] === 'install' && env?.CLAUDE_CONFIG_DIR === work) return { ok: false, stdout: '', stderr: 'offline' };
      if (args[1] === 'list' && args[2] === '--json') return { ok: true, stdout: '[]' };
      return { ok: true, stdout: 'moberg-plugins' };
    };
    const r = await claudeSkillsWith(run).install({ skillsDir: null });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('work: could not install');
    expect(r.message).toContain('default: installed');
    expect(calls.filter((c) => c.args[1] === 'install')).toHaveLength(3);
  });

  it('with no accounts it is the one plain run, with no environment given', async () => {
    writeConfig();
    const { calls, run } = recorder();
    await claudeSkillsWith(run).install({ skillsDir: null });
    expect(calls.every((c) => c.env === undefined)).toBe(true);
  });
});

describe('usage names', () => {
  const window = [{ id: 'five_hour', label: '5-hour limit', usedPercent: 10, resetsAt: null }];

  it('a reading kept under an account’s folder hash is named by the configured account; the default is marked', () => {
    withAccounts({ claudeAccount: 'work' });
    recordReading('claude', 'default', window);
    recordReading('claude', accountOf(work), window);
    recordReading('claude', 'cfg-deadbeef', window); // a folder that is no account (any more)
    const read = claudeUsage.read();
    expect(read.map((r) => r.account).sort()).toEqual(['cfg-deadbeef', 'default', 'work']);
    expect(read.find((r) => r.account === 'work')!.isDefault).toBe(true);
    expect(read.find((r) => r.account === 'default')!.isDefault).toBeUndefined();
    expect(read.find((r) => r.account === 'cfg-deadbeef')!.isDefault).toBeUndefined();
  });

  it('with no accounts the one reading is the default account', () => {
    writeConfig();
    recordReading('claude', 'default', window);
    expect(claudeUsage.read()).toMatchObject([{ account: 'default', isDefault: true }]);
  });

  it('the wire carries the names and the default mark', async () => {
    withAccounts();
    recordReading('claude', accountOf(alt), window);
    const wire = await buildUsage({
      agents: () => [{ id: 'claude', name: 'Claude Code', usage: claudeUsage }],
      sessions: () => [],
      tokens: async () => ({}),
      label: () => '',
    });
    expect(wire.agents[0]!.accounts).toMatchObject([{ account: 'alt' }]);
    expect(wire.agents[0]!.accounts[0]!.isDefault).toBeUndefined();
  });
});
