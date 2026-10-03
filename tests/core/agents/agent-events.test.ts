import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hearing an agent's turns (agents/: `events`): work's hooks in its settings,
 * what it sends them, how notes are handed back — Claude's adapter, `work
 * web`'s install of every agent's hooks, and `work hook --agent`.
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

  it('removeSync before any install in the process removes nothing (work web always installs first)', async () => {
    vi.resetModules();
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ hooks: { Stop: [{ _workOwner: 'web-turn', hooks: [{ type: 'command', command: 'work hook turn-end' }] }] } }),
    );
    const { claudeAgent } = await import('../../../src/core/agents/claude/adapter.js');
    claudeAgent.events!.removeSync([{ owner: 'web-turn', edge: 'turn-end' }]);
    expect(commands('Stop')).toEqual(['work hook turn-end']);
  });
});

describe('work web installs work’s hooks in every agent that has them', () => {
  it('full: one hook per turn edge plus notify, under Claude’s event names; removed on shutdown', async () => {
    const { installAgentHooks, removeAgentHooksSync } = await import('../../../src/commands/web.js');
    await installAgentHooks(false);
    expect(commands('UserPromptSubmit')).toEqual(['work hook turn-start']);
    expect(commands('Stop')).toEqual(['work hook turn-end']);
    expect(commands('Notification')).toEqual(['work hook status-notify']);
    removeAgentHooksSync(false);
    expect(commands('UserPromptSubmit')).toEqual([]);
  });

  it('lean (`wd`): only the checkpoints', async () => {
    const { installAgentHooks } = await import('../../../src/commands/web.js');
    await installAgentHooks(true);
    expect(commands('Stop')).toEqual(['work hook checkpoint']);
    expect(commands('UserPromptSubmit')).toEqual(['work hook checkpoint-seal']);
    expect(commands('Notification')).toEqual([]);
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

describe('instructions file, restore, chat (agents/)', () => {
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
      summary: { prompts: [], promptCount: 0, lastSummary: null, prs: [], jiraKey: null },
    });
    // The session's agent is opencode: nowhere to put it back (the archive keeps it).
    fs.writeFileSync(path.join(tmp, '.work', 'config.json'), JSON.stringify(config('opencode')));
    expect(restoreArchivedTranscripts(s)).toBe(0);
    // Claude's: back in its projects folder for that worktree.
    fs.writeFileSync(path.join(tmp, '.work', 'config.json'), JSON.stringify(config()));
    expect(restoreArchivedTranscripts(s)).toBe(1);
    expect(fs.existsSync(path.join(tmp, '.claude', 'projects', encodeProjectDir(path.join(tmp, 'wt', 'r')), 'c.jsonl'))).toBe(true);
  });

  it('the chat runs only for an agent that has one', async () => {
    fs.mkdirSync(path.join(tmp, '.work'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.work', 'config.json'), JSON.stringify(config('opencode')));
    const wt = path.join(tmp, 'wt', 'api', 'feat-x');
    fs.mkdirSync(wt, { recursive: true });
    const { saveHistory } = await import('../../../src/core/sessions/history.js');
    const { sessionIdFor } = await import('../../../src/core/sessions/session-id.js');
    saveHistory([{ target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: '', lastAccessedAt: '' }]);
    const { Hono } = await import('hono');
    const { mountChatRoutes } = await import('../../../src/server/routes/chat-routes.js');
    const app = new Hono();
    mountChatRoutes(app, { broadcast: () => {}, baseUrl: () => 'http://127.0.0.1:1/' } as never);
    const res = await app.request(`/api/sessions/${sessionIdFor({ target: 'api', branch: 'feat/x' })}/chat/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/opencode has no chat here/);
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
