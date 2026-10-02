import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentById, agentFor } from '../../src/core/agents/index.js';
import { claudeAgent, claudeEntries } from '../../src/core/agents/claude.js';
import { claudeContextWindow, DEFAULT_WINDOW, LARGE_WINDOW } from '../../src/core/agents/claude-entries.js';
import { encodeProjectDir } from '../../src/core/claude-activity.js';
import type { WorktreeSession } from '../../src/core/history.js';
import type { TranscriptEntry } from '../../src/core/transcript-entry.js';

/** The agent interface's first slice: a session's conversation in work's own terms, read from Claude Code's transcripts. */

const user = (at: string, content: unknown, extra: object = {}) => ({ type: 'user', timestamp: at, message: { role: 'user', content }, ...extra }) as TranscriptEntry;
const assistant = (at: string, content: unknown, extra: object = {}) => ({ type: 'assistant', timestamp: at, message: { role: 'assistant', content }, ...extra }) as TranscriptEntry;

describe('claudeEntries (pure): every line of a Claude transcript, in work’s own terms', () => {
  it('your prompts, its text and tool calls, tool results, the rest as `other` — subagent lines marked, ids kept', () => {
    const out = claudeEntries([
      user('2026-10-02T09:00:00Z', 'Add the CSV export', { uuid: 'u1' }),
      user('2026-10-02T09:00:01Z', '<command-name>/clear</command-name>'),
      assistant('2026-10-02T09:00:02Z', [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
      user('2026-10-02T09:00:03Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      assistant('2026-10-02T09:00:04Z', [{ type: 'text', text: 'subagent work' }], { isSidechain: true }),
      assistant('2026-10-02T09:00:05Z', [{ type: 'thinking', thinking: '…' }]),
      { type: 'system', timestamp: '2026-10-02T09:00:06Z' } as TranscriptEntry,
    ]);
    expect(out).toEqual([
      { at: '2026-10-02T09:00:00Z', id: 'u1', role: 'you', text: 'Add the CSV export' },
      { at: '2026-10-02T09:00:01Z', role: 'other', text: '' }, // an echo: not something you typed
      { at: '2026-10-02T09:00:02Z', role: 'agent', text: 'On it.' },
      { at: '2026-10-02T09:00:02Z', role: 'tool', tool: 'Bash', text: 'npm test' },
      { at: '2026-10-02T09:00:03Z', role: 'tool-result', text: '' },
      { at: '2026-10-02T09:00:04Z', sidechain: true, role: 'agent', text: 'subagent work' },
      { at: '2026-10-02T09:00:05Z', role: 'agent', text: '' }, // only thinking: still its line (work time)
      { at: '2026-10-02T09:00:06Z', role: 'other', text: '' },
    ]);
  });

  it('an agent message carries its usage (prompt with the cache, and the reply) and its model; the window by model or size', () => {
    const [e] = claudeEntries([
      { type: 'assistant', timestamp: 't', message: { model: 'claude-opus-5-5[1m]', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 7 }, content: [{ type: 'text', text: 'ok' }] } } as TranscriptEntry,
    ]);
    expect(e).toMatchObject({ role: 'agent', usage: { prompt: 1015, reply: 7 }, model: 'claude-opus-5-5[1m]' });
    expect(claudeContextWindow('claude-opus-5-5[1m]', 10)).toBe(LARGE_WINDOW);
    expect(claudeContextWindow('claude-sonnet-5', 250_000)).toBe(LARGE_WINDOW);
    expect(claudeContextWindow('claude-sonnet-5', 10)).toBe(DEFAULT_WINDOW);
  });

  it('a line with no time is kept with `at: ""` (search and context usage read it)', () => {
    expect(claudeEntries([{ type: 'assistant', message: { content: [{ type: 'text', text: 'no time' }] } } as TranscriptEntry])).toEqual([{ at: '', role: 'agent', text: 'no time' }]);
    expect(claudeEntries([null, 'x', 3])).toEqual([]); // not lines
  });
});

describe('the Claude adapter’s files and entries', () => {
  it('are its transcripts and its line mapping', () => {
    expect(claudeAgent.conversation!.entries).toBe(claudeEntries);
    expect(claudeAgent.conversation!.contextWindow).toBe(claudeContextWindow);
  });
});

describe('claudeAgent.conversation.read (transcript files)', () => {
  let home: string;
  let wt: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    wt = path.join(home, 'wt', 'api', 'feat-x');
    fs.mkdirSync(wt, { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const write = (name: string, entries: object[], mtime: Date) => {
    const dir = path.join(home, '.claude', 'projects', encodeProjectDir(wt));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.utimesSync(f, mtime, mtime);
  };
  const session = () => ({ target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: '', lastAccessedAt: '' }) as WorktreeSession;

  it('the newest messages, oldest first; an older conversation fills in when the newest is short', () => {
    write('old.jsonl', [user('2026-10-01T10:00:00Z', 'Yesterday’s ask'), assistant('2026-10-01T10:01:00Z', [{ type: 'text', text: 'Yesterday’s answer' }])], new Date('2026-10-01T10:01:00Z'));
    write('new.jsonl', [user('2026-10-02T09:00:00Z', 'Today’s ask'), assistant('2026-10-02T09:01:00Z', [{ type: 'text', text: 'Today’s answer' }])], new Date('2026-10-02T09:01:00Z'));
    const read = (last: number) => claudeAgent.conversation!.read(session(), { last }).map((e) => e.text);
    expect(read(2)).toEqual(['Today’s ask', 'Today’s answer']);
    expect(read(3)).toEqual(['Yesterday’s answer', 'Today’s ask', 'Today’s answer']);
  });

  it('no transcripts: nothing', () => {
    expect(claudeAgent.conversation!.read(session(), { last: 5 })).toEqual([]);
  });
});

describe('agentFor', () => {
  it('Claude Code by default; another tool is a plain agent: it starts, nothing else', () => {
    expect(agentFor(null)).toBe(claudeAgent);
    expect(agentFor({ aiCommand: 'claude --model opus' })).toBe(claudeAgent);
    const other = agentFor({ aiCommand: 'opencode' });
    expect(other).toMatchObject({ id: 'opencode', name: 'opencode' });
    expect(other.conversation).toBeUndefined();
  });

  it('a session runs the agent it was created with, whatever the default is now', () => {
    expect(agentFor({ aiCommand: 'claude' }, { agent: 'opencode' }).id).toBe('opencode');
    expect(agentFor({ aiCommand: 'opencode' }, { agent: 'claude' })).toBe(claudeAgent);
    expect(agentFor({ aiCommand: 'opencode' }, {}).id).toBe('opencode'); // from before: the default
    expect(agentById('claude')).toBe(claudeAgent);
  });
});

describe('launch', () => {
  it('Claude: the configured command when it is Claude, plain claude otherwise; drops a parent session’s variables', () => {
    expect(claudeAgent.launch.tool({ aiCommand: 'claude --model opus' })).toMatchObject({ cmd: 'claude', baseArgs: ['--model', 'opus'], resumeFlag: '--continue' });
    expect(claudeAgent.launch.tool({ aiCommand: 'opencode' })).toMatchObject({ cmd: 'claude', baseArgs: [] }); // the assistant runs Claude whatever the default
    const env = claudeAgent.launch.cleanEnv({ CLAUDECODE: '1', PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('a plain agent: its preset flags (or the configured ones), never a resume, the env as it is', () => {
    const op = agentById('opencode');
    expect(op.launch.tool(null)).toMatchObject({ cmd: 'opencode', resumeFlag: '--continue', promptFlag: '--prompt' });
    expect(op.launch.tool({ aiCommand: 'opencode --verbose' })).toMatchObject({ baseArgs: ['--verbose'] });
    expect(op.launch.tool({ aiCommand: 'claude' }).cmd).toBe('opencode'); // the session's agent, not the default's command
    expect(op.launch.canResume('/anywhere')).toBe(false);
    const g = { target: 'shop', branch: 'b', isGroup: true, paths: ['/wt/shop/b/api', '/wt/shop/b/web'], createdAt: '', lastAccessedAt: '' } as WorktreeSession;
    expect(op.launch.resumeLaunch(g)).toEqual({ launchPath: path.dirname('/wt/shop/b/api'), hasConversation: false });
    expect(op.launch.cleanEnv({ CLAUDECODE: '1' })).toEqual({ CLAUDECODE: '1' });
  });
});
