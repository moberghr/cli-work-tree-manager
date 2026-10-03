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
  settingsFile = path.join(tmp, '.claude', 'settings.json');
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const commands = (event: string) =>
  ((JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }).hooks?.[event] ?? []).map((e) => e.hooks[0].command);

describe('Claude’s events', () => {
  it('reads the folder and a status per turn edge from what Claude Code sends', async () => {
    const { claudeAgent } = await import('../../src/core/agents/claude.js');
    const ev = claudeAgent.events!;
    expect(ev.read('turn-start', { cwd: '/wt/x', prompt: 'go' })).toEqual({ cwd: '/wt/x', status: { kind: 'prompt', prompt: 'go' } });
    expect(ev.read('turn-end', {})).toEqual({ cwd: undefined, status: { kind: 'stop', lastMessage: undefined } });
    expect(ev.read('notify', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }).status).toEqual({
      kind: 'notification',
      message: 'Claude needs your permission to use Bash',
      type: 'permission_prompt',
    });
    // Not an object: nothing in it, never a crash (a hook must not fail Claude's turn).
    expect(ev.read('turn-start', 'garbage')).toEqual({ cwd: undefined, status: { kind: 'prompt', prompt: undefined } });
  });

  it('hands notes over as Claude Code takes them: added to the prompt; at Stop, `decision: block`', async () => {
    const { claudeAgent } = await import('../../src/core/agents/claude.js');
    expect(claudeAgent.events!.handOver('turn-start', 'note')).toBe('note\n');
    expect(JSON.parse(claudeAgent.events!.handOver('turn-end', 'note'))).toEqual({ decision: 'block', reason: 'note' });
  });

  it('removeSync before any install in the process removes nothing (work web always installs first)', async () => {
    vi.resetModules();
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ _workOwner: 'web-turn', hooks: [{ type: 'command', command: 'work hook turn-end' }] }] } }));
    const { claudeAgent } = await import('../../src/core/agents/claude.js');
    claudeAgent.events!.removeSync([{ owner: 'web-turn', edge: 'turn-end' }]);
    expect(commands('Stop')).toEqual(['work hook turn-end']);
  });
});

describe('work web installs work’s hooks in every agent that has them', () => {
  it('full: one hook per turn edge plus notify, under Claude’s event names; removed on shutdown', async () => {
    const { installAgentHooks, removeAgentHooksSync } = await import('../../src/commands/web.js');
    await installAgentHooks(false);
    expect(commands('UserPromptSubmit')).toEqual(['work hook turn-start']);
    expect(commands('Stop')).toEqual(['work hook turn-end']);
    expect(commands('Notification')).toEqual(['work hook status-notify']);
    removeAgentHooksSync(false);
    expect(commands('UserPromptSubmit')).toEqual([]);
  });

  it('lean (`wd`): only the checkpoints', async () => {
    const { installAgentHooks } = await import('../../src/commands/web.js');
    await installAgentHooks(true);
    expect(commands('Stop')).toEqual(['work hook checkpoint']);
    expect(commands('UserPromptSubmit')).toEqual(['work hook checkpoint-seal']);
    expect(commands('Notification')).toEqual([]);
  });
});

describe('work hook --agent', () => {
  it('a hook says which agent runs it; one with no hooks records no status, and notes go as plain text', async () => {
    const { statusEventFor, computeHookOutput } = await import('../../src/commands/hook.js');
    const { agentById } = await import('../../src/core/agents/index.js');
    expect(statusEventFor('status-prompt', { prompt: 'go' })).toEqual({ kind: 'prompt', prompt: 'go' }); // Claude, the default
    expect(statusEventFor('status-prompt', { prompt: 'go' }, agentById('opencode'))).toBeNull();
    // Outside a session there's nothing to hand over, whoever runs it.
    expect(computeHookOutput({ event: 'stop', cwd: tmp }, undefined, agentById('opencode'))).toBeNull();
  });

  it('reads the agent from its arguments; Claude when there is none (its hooks predate --agent)', async () => {
    const { hookAgentArg } = await import('../../src/commands/hook.js');
    expect(hookAgentArg([])).toBe('claude');
    expect(hookAgentArg(['--agent', 'codex'])).toBe('codex');
    expect(hookAgentArg(['--agent'])).toBe('claude');
    expect(hookAgentArg(['--agent', '--other'])).toBe('claude');
  });
});
