import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hearing an agent's turns (agents/: `events`): what it sends work's hooks,
 * how notes are handed back, the hooks given to the Claudes work starts
 * (`--settings`), `work web`'s clean-up of older installs, and `work hook --agent`.
 */

let tmp: string;
let settingsFile: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-events-'));
  fs.mkdirSync(path.join(tmp, '.claude'));
  fs.mkdirSync(path.join(tmp, '.work'));
  settingsFile = path.join(tmp, '.claude', 'settings.json');
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const commands = (event: string) =>
  (
    (JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> })
      .hooks?.[event] ?? []
  ).map((e) => e.hooks[0].command);

describe('Claude’s events', () => {
  it('reads the folder and a status per turn edge from what Claude Code sends', async () => {
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    const ev = claudeAgent.events!;
    expect(ev.read('turn-start', { cwd: '/wt/x', prompt: 'go' })).toEqual({ cwd: '/wt/x', status: { kind: 'prompt', prompt: 'go' } });
    expect(ev.read('turn-end', {})).toEqual({ cwd: undefined, status: { kind: 'stop', lastMessage: undefined } });
    expect(
      ev.read('notify', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }).status,
    ).toEqual({
      kind: 'notification',
      message: 'Claude needs your permission to use Bash',
      type: 'permission_prompt',
    });
    // Not an object: nothing in it, never a crash (a hook must not fail Claude's turn).
    expect(ev.read('turn-start', 'garbage')).toEqual({ cwd: undefined, status: { kind: 'prompt', prompt: undefined } });
  });

  it('hands notes over as Claude Code takes them: added to the prompt; at Stop, `decision: block`', async () => {
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    expect(claudeAgent.events!.handOver('turn-start', 'note')).toBe('note\n');
    expect(JSON.parse(claudeAgent.events!.handOver('turn-end', 'note'))).toEqual({ decision: 'block', reason: 'note' });
  });
});

describe('work’s hooks ride with the Claudes work starts, never the user’s settings', () => {
  it('the session file: one hook per turn edge plus notify, under Claude’s event names, each running THIS work by its path, and the status line', async () => {
    const { claudeSessionSettings } = await import('../../../src/core/agents/claude/session-settings.js');
    const invocation = {
      argv1: '/opt/work/dist/bin.js',
      execPath: '/opt/node/bin/node',
      platform: 'linux' as const,
      configDir: '/h/.work',
    };
    const s = claudeSessionSettings({ statusLine: true, invocation }) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
      statusLine: { command: string };
    };
    const cmd = (e: string) => s.hooks[e]!.map((h) => h.hooks[0]!.command);
    expect(cmd('UserPromptSubmit')).toEqual(['/opt/node/bin/node /opt/work/dist/bin.js hook turn-start']);
    expect(cmd('Stop')).toEqual(['/opt/node/bin/node /opt/work/dist/bin.js hook turn-end']);
    expect(cmd('Notification')).toEqual(['/opt/node/bin/node /opt/work/dist/bin.js hook status-notify']);
    expect(s.statusLine.command).toBe('/opt/node/bin/node /opt/work/dist/bin.js hook statusline');
    // config usage.statusLine: false — the user's own line stays theirs.
    expect(claudeSessionSettings({ statusLine: false, invocation })).not.toHaveProperty('statusLine');
  });

  it("the file has work's line when the limits' reading is on, or when work's own line is chosen", async () => {
    const { writeSessionSettings } = await import('../../../src/core/agents/claude/session-settings.js');
    const has = (config: object) => {
      fs.writeFileSync(path.join(tmp, '.work', 'config.json'), JSON.stringify({ worktreesRoot: tmp, ...config }));
      return 'statusLine' in (JSON.parse(fs.readFileSync(writeSessionSettings(), 'utf-8')) as object);
    };
    expect(has({})).toBe(true);
    expect(has({ usage: { statusLine: false } })).toBe(false);
    expect(has({ usage: { statusLine: false }, claudeStatusLine: 'work' })).toBe(true);
  });

  it('a session’s Claude starts with `--settings <work’s file>` first, once (a restore entry from before is brought up to date), the file written', async () => {
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    const { sessionToolFor } = await import('../../../src/core/agents/index.js');
    const file = path.join(tmp, '.work', 'claude-settings.json');
    const plain = claudeAgent.launch.tool({ aiCommand: 'claude --model opus' });
    const started = sessionToolFor(plain);
    expect(started.baseArgs).toEqual(['--settings', file, '--model', 'opus']);
    expect(
      sessionToolFor({ ...plain, baseArgs: ['--settings', '/old/home/.work/claude-settings.json', '--model', 'opus'] }).baseArgs,
    ).toEqual(['--settings', file, '--model', 'opus']);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toHaveProperty('hooks.Stop');
    // Another agent: started as it is.
    const { agentById } = await import('../../../src/core/agents/index.js');
    const other = agentById('opencode').launch.tool(null);
    expect(sessionToolFor(other)).toEqual(other);
  });

  it('the user’s settings are left alone: no hook of work’s is written there', async () => {
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    const { sessionToolFor } = await import('../../../src/core/agents/index.js');
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
    const before = fs.readFileSync(settingsFile, 'utf-8');
    sessionToolFor(claudeAgent.launch.tool(null));
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });
});

describe('work web takes out what older builds wrote into the user’s settings', () => {
  it('every old owner’s hooks go (tagged or not), the user’s own stay, and the wrapped status line comes back', async () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        statusLine: { type: 'command', command: 'work hook statusline || (mine-line)' },
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'mine' }] },
            { _workHookOwner: 'web-turn', _workHookPid: 1, hooks: [{ type: 'command', command: 'work hook turn-end' }] },
            { hooks: [{ type: 'command', command: 'work hook checkpoint' }] },
          ],
          UserPromptSubmit: [{ _workHookOwner: 'web-checkpoint', hooks: [{ type: 'command', command: 'work hook checkpoint-seal' }] }],
          Notification: [{ _workHookOwner: 'web-status', hooks: [{ type: 'command', command: 'work hook status-notify' }] }],
        },
      }),
    );
    fs.writeFileSync(path.join(tmp, '.work', 'statusline.json'), JSON.stringify({ original: { type: 'command', command: 'mine-line' } }));
    const { removeRetiredAgentSetup } = await import('../../../src/commands/web.js');
    (await removeRetiredAgentSetup()).stop();
    expect(commands('Stop')).toEqual(['mine']);
    expect(commands('UserPromptSubmit')).toEqual([]);
    expect(commands('Notification')).toEqual([]);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).statusLine).toEqual({ type: 'command', command: 'mine-line' });
  });

  it('a session’s Claude from before the update still running: work’s hooks stay, as the very commands its new Claudes carry; gone once it is', async () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'mine' }] },
            { _workHookOwner: 'web-turn', hooks: [{ type: 'command', command: 'work hook turn-end' }] },
          ],
        },
      }),
    );
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    const { claudeSessionSettings } = await import('../../../src/core/agents/claude/session-settings.js');
    const running = [
      { pid: 7, conversationId: 'c', cwd: '/wt/a', busy: false, state: 'idle' as const, stateAt: null, waitingFor: null, startedAt: 1 },
    ];
    const claude = { ...claudeAgent, live: { running: () => running } };
    const { removeRetiredAgentSetup } = await import('../../../src/commands/web.js');
    const io = {
      agents: () => [claude],
      commandLines: async () => new Map([[7, 'claude --continue']]),
      inSession: () => true,
      since: 1_000,
    };
    const first = await removeRetiredAgentSetup({ ...io, everyMs: 60_000 });
    first.stop();
    expect(first.first).toEqual([{ agent: 'claude', done: 'bridged', waitingOn: 1 }]);
    // The bare `work hook turn-end` is replaced by the session file's own command: a Claude with both runs it once.
    const session = claudeSessionSettings({ statusLine: true }) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(commands('Stop')).toEqual(['mine', session.hooks.Stop![0]!.hooks[0]!.command]);
    expect(commands('UserPromptSubmit')).toEqual([session.hooks.UserPromptSubmit![0]!.hooks[0]!.command]);
    expect(commands('Stop').join(' ')).not.toMatch(/^work hook|\swork hook/);
    // It was restarted (or quit): the next look takes them out.
    running.splice(0);
    (await removeRetiredAgentSetup({ ...io, everyMs: 60_000 })).stop();
    expect(commands('Stop')).toEqual(['mine']);
    expect(commands('UserPromptSubmit')).toEqual([]);
  });

  it('settings with nothing of work’s aren’t written at all', async () => {
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }, null, 1);
    fs.writeFileSync(settingsFile, text);
    const { removeRetiredAgentSetup } = await import('../../../src/commands/web.js');
    (await removeRetiredAgentSetup()).stop();
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(text);
  });
});

describe('which agents run now (agents/: `live`)', () => {
  it('every known agent’s running processes — Claude’s from its own ~/.claude/sessions files — believed only for a live Claude pid', async () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'sessions'), { recursive: true });
    const file = (pid: number, cwd: string) =>
      fs.writeFileSync(
        path.join(tmp, '.claude', 'sessions', `${pid}.json`),
        JSON.stringify({ pid, sessionId: `conv-${pid}`, cwd, status: 'busy', statusUpdatedAt: 1 }),
      );
    file(4242, '/wt/api');
    file(5151, '/wt/web'); // its pid now runs something else
    const { liveAgents } = await import('../../../src/core/agents/index.js');
    const table = new Map([
      [4242, 'claude.exe'],
      [5151, 'notepad.exe'],
    ]);
    expect(liveAgents(table)).toEqual([
      { pid: 4242, conversationId: 'conv-4242', cwd: '/wt/api', busy: true, state: 'busy', stateAt: 1, waitingFor: null, startedAt: null },
    ]);
  });
});

describe('typing into an agent (agents/: `input`)', () => {
  it('text, a pause, then Enter apart (Claude reads a burst as a paste); a plain agent the same, and no dialog it can answer', async () => {
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    const { agentById } = await import('../../../src/core/agents/index.js');
    const writes: string[] = [];
    const waits: number[] = [];
    const ok = await agentById('opencode').input.submit(
      async (d) => (writes.push(d), true),
      'run it',
      async (ms) => void waits.push(ms),
    );
    expect([ok, writes, waits]).toEqual([true, ['run it', '\r'], [250]]);
    expect(agentById('opencode').input.permissionDialog).toBeUndefined();
    expect(claudeAgent.input.permissionDialog!.keys).toEqual({ allow: '\r', deny: '\x1b' });
    // A write that fails: no Enter.
    const lost: string[] = [];
    expect(
      await claudeAgent.input.submit(
        async (d) => (lost.push(d), false),
        'x',
        async () => {},
      ),
    ).toBe(false);
    expect(lost).toEqual(['x']);
  });
});

describe('work’s own summaries (agents/: `oneShot`, config internalAgent)', () => {
  it('Claude’s one-shot: `claude -p`, no tools, no MCP servers, a neutral folder, tagged internal; a small model for a few words', async () => {
    const { claudeAgent, CLAUDE_SMALL_MODEL } = await import('../../../src/core/agents/claude/adapter.js');
    const run = claudeAgent.oneShot!.command({});
    expect(run).toMatchObject({ cmd: 'claude', args: ['-p', '--tools', '', '--strict-mcp-config'], cwd: os.tmpdir() });
    expect(run.env.WORK_INTERNAL_CLAUDE).toBe('1');
    expect(claudeAgent.oneShot!.command({ small: true }).args).toEqual([
      '-p',
      '--tools',
      '',
      '--strict-mcp-config',
      '--model',
      CLAUDE_SMALL_MODEL,
    ]);
  });

  it('Claude’s read-only one-shot in a folder (a PR’s checkout): read-only file tools confined to it, none of its settings or MCP servers, its CLAUDE.md loaded, tagged internal', async () => {
    const { claudeAgent, CLAUDE_SMALL_MODEL } = await import('../../../src/core/agents/claude/adapter.js');
    const dir = path.join(tmp, 'review-trees', 'api-5-abc');
    const run = claudeAgent.oneShot!.readOnly!.command({ cwd: dir });
    expect(run).toEqual({
      cmd: 'claude',
      args: [
        '-p',
        '--restricted',
        '--tools',
        'Read,Grep,Glob',
        '--setting-sources',
        'user',
        '--add-dir',
        dir,
        '--strict-mcp-config',
        '--permission-mode',
        'dontAsk',
      ],
      cwd: dir,
      env: expect.objectContaining({ WORK_INTERNAL_CLAUDE: '1', CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' }) as unknown,
    });
    // Nothing that runs or writes is named anywhere.
    expect(run.args.join(' ')).not.toMatch(/Bash|Edit|Write|WebFetch|WebSearch|bypassPermissions|--mcp-config/);
    expect(claudeAgent.oneShot!.readOnly!.command({ cwd: dir, small: true }).args.slice(-2)).toEqual(['--model', CLAUDE_SMALL_MODEL]);
    // What only Claude knows of the run (#64 F005): its settings files, in any case, and its prompt's words on its tools and CLAUDE.md.
    const ro = claudeAgent.oneShot!.readOnly!;
    expect(['.claude/settings.json', '.Claude/Settings.Local.json', 'x/.MCP.json'].every((f) => ro.isSettingsFile(f))).toBe(true);
    expect(ro.isSettingsFile('CLAUDE.md')).toBe(false);
    expect(ro.promptLines.join(' ')).toMatch(/Read, Grep and Glob/);
    expect(ro.promptLines.join(' ')).toMatch(/CLAUDE\.md/);
  });

  it('an agent without a read-only mode: none, and runInternalReadOnly starts nothing', async () => {
    const { internalAgent } = await import('../../../src/core/agents/index.js');
    expect(internalAgent({ internalAgent: 'opencode' }).oneShot?.readOnly).toBeUndefined();
    fs.writeFileSync(
      path.join(tmp, '.work', 'config.json'),
      JSON.stringify({ worktreesRoot: tmp, repos: {}, groups: {}, copyFiles: [], internalAgent: 'opencode' }),
    );
    const { internalCanRead, runInternalReadOnly } = await import('../../../src/core/diff/checkpoint-summary.js');
    expect(internalCanRead()).toBe(false);
    const started = Date.now();
    expect(await runInternalReadOnly('review this', tmp, 300_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('the summarising agent is config internalAgent (Claude by default); one without one-shot runs writes nothing — no process started', async () => {
    const { internalAgent } = await import('../../../src/core/agents/index.js');
    expect(internalAgent(null).id).toBe('claude');
    expect(internalAgent({ internalAgent: 'opencode' }).oneShot).toBeUndefined();
    fs.writeFileSync(
      path.join(tmp, '.work', 'config.json'),
      JSON.stringify({ worktreesRoot: tmp, repos: {}, groups: {}, copyFiles: [], internalAgent: 'opencode' }),
    );
    const { runInternal } = await import('../../../src/core/diff/checkpoint-summary.js');
    const started = Date.now();
    expect(await runInternal('summarise this', 25_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000); // answered at once: nothing ran
  });
});

describe('instructions file, restore (agents/)', () => {
  const config = (aiCommand?: string) => ({
    worktreesRoot: tmp,
    repos: { api: path.join(tmp, 'api') },
    groups: { shop: ['api'] },
    copyFiles: [],
    ...(aiCommand ? { aiCommand } : {}),
    internalAgent: 'opencode',
  });

  it('the file an agent reads: CLAUDE.md for Claude, AGENTS.md (the shared convention) for one with no adapter', async () => {
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    const { agentById } = await import('../../../src/core/agents/index.js');
    expect(claudeAgent.instructionsFile).toBe('CLAUDE.md');
    expect(agentById('codex').instructionsFile).toBe('AGENTS.md');
  });

  it('a group’s combined file is made from each repo’s file of that name, and says which (the template, when no agent writes it)', async () => {
    fs.mkdirSync(path.join(tmp, 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'api', 'AGENTS.md'), '# api agents notes');
    fs.writeFileSync(path.join(tmp, 'api', 'CLAUDE.md'), '# api claude notes');
    const { generateGroupInstructions } = await import('../../../src/core/agents/group-instructions.js');
    const out = path.join(tmp, '.work', 'shop.claude.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    generateGroupInstructions('shop', ['api'], config('opencode') as never);
    expect(fs.readFileSync(out, 'utf8')).toContain('# api agents notes');
    generateGroupInstructions('shop', ['api'], config() as never);
    expect(fs.readFileSync(out, 'utf8')).toContain('# api claude notes');
  });

  it('an archived conversation goes back where Claude looks (the folder it runs in; a group’s root); an agent without restoreDir: nowhere', async () => {
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    const { encodeProjectDir } = await import('../../../src/core/agents/claude/activity.js');
    const group = {
      target: 'shop',
      branch: 'b',
      isGroup: true,
      paths: [path.join(tmp, 'wt', 'shop', 'b', 'api')],
      createdAt: '',
      lastAccessedAt: '',
    };
    expect(claudeAgent.conversation!.restoreDir!(group)).toBe(
      path.join(tmp, '.claude', 'projects', encodeProjectDir(path.join(tmp, 'wt', 'shop', 'b'))),
    );
    // A real archive with one conversation file.
    const s = { target: 'api', branch: 'feat/r', isGroup: false, paths: [path.join(tmp, 'wt', 'r')], createdAt: '', lastAccessedAt: '' };
    const { sessionIdFor } = await import('../../../src/core/sessions/session-id.js');
    const { writeArchiveRecord, archiveRoot, restoreArchivedTranscripts } = await import('../../../src/core/archive/session-archive.js');
    const id = sessionIdFor(s);
    fs.mkdirSync(path.join(archiveRoot(), id, 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot(), id, 'transcripts', 'c.jsonl'), '{}\n');
    writeArchiveRecord({
      sessionId: id,
      target: 'api',
      branch: 'feat/r',
      isGroup: false,
      paths: s.paths,
      archivedAt: 'x',
      worktreeRemoved: true,
      keptBecause: null,
      transcripts: [{ file: 'c.jsonl', projectDir: 'p' }],
      summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [], issueKey: null },
    });
    // The session's agent is opencode: nowhere to put it back (the archive keeps it).
    fs.writeFileSync(path.join(tmp, '.work', 'config.json'), JSON.stringify(config('opencode')));
    expect(restoreArchivedTranscripts(s)).toBe(0);
    // Claude's: back in its projects folder for that worktree.
    fs.writeFileSync(path.join(tmp, '.work', 'config.json'), JSON.stringify(config()));
    expect(restoreArchivedTranscripts(s)).toBe(1);
    expect(fs.existsSync(path.join(tmp, '.claude', 'projects', encodeProjectDir(path.join(tmp, 'wt', 'r')), 'c.jsonl'))).toBe(true);
  });
});

describe('work hook --agent', () => {
  it('a hook says which agent runs it; one with no hooks records no status, and notes go as plain text', async () => {
    const { statusEventFor, computeHookOutput } = await import('../../../src/commands/hook.js');
    const { agentById } = await import('../../../src/core/agents/index.js');
    expect(statusEventFor('status-prompt', { prompt: 'go' })).toEqual({ kind: 'prompt', prompt: 'go' }); // Claude, the default
    expect(statusEventFor('status-prompt', { prompt: 'go' }, agentById('opencode'))).toBeNull();
    // Outside a session there's nothing to hand over, whoever runs it.
    expect(computeHookOutput({ event: 'stop', cwd: tmp }, undefined, agentById('opencode'))).toBeNull();
  });

  it('reads the agent from its arguments; Claude when there is none (its hooks predate --agent)', async () => {
    const { hookAgentArg } = await import('../../../src/commands/hook.js');
    expect(hookAgentArg([])).toBe('claude');
    expect(hookAgentArg(['--agent', 'codex'])).toBe('codex');
    expect(hookAgentArg(['--agent'])).toBe('claude');
    expect(hookAgentArg(['--agent', '--other'])).toBe('claude');
  });
});
