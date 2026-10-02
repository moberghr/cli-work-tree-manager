import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentById, agentFor } from '../../src/core/agents/index.js';
import { claudeAgent, claudeEntries } from '../../src/core/agents/claude.js';
import { encodeProjectDir } from '../../src/core/claude-activity.js';
import type { WorktreeSession } from '../../src/core/history.js';
import type { TranscriptEntry } from '../../src/core/transcript-entry.js';

/** The agent interface's first slice: a session's conversation in work's own terms, read from Claude Code's transcripts. */

const user = (at: string, content: unknown, extra: object = {}) => ({ type: 'user', timestamp: at, message: { role: 'user', content }, ...extra }) as TranscriptEntry;
const assistant = (at: string, content: unknown, extra: object = {}) => ({ type: 'assistant', timestamp: at, message: { role: 'assistant', content }, ...extra }) as TranscriptEntry;

describe('claudeEntries (pure)', () => {
  it('your prompts, its text, its tool calls — not tool results, echoes, meta or subagent lines', () => {
    const out = claudeEntries([
      user('2026-10-02T09:00:00Z', 'Add the CSV export'),
      user('2026-10-02T09:00:01Z', '<command-name>/clear</command-name>'),
      assistant('2026-10-02T09:00:02Z', [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
      user('2026-10-02T09:00:03Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      assistant('2026-10-02T09:00:04Z', [{ type: 'text', text: 'subagent work' }], { isSidechain: true }),
      assistant('2026-10-02T09:00:05Z', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/export.ts' } }]),
      assistant('2026-10-02T09:00:06Z', [{ type: 'text', text: 'Done: export added.' }]),
    ]);
    expect(out).toEqual([
      { at: '2026-10-02T09:00:00Z', role: 'you', text: 'Add the CSV export' },
      { at: '2026-10-02T09:00:02Z', role: 'agent', text: 'On it.' },
      { at: '2026-10-02T09:00:02Z', role: 'tool', tool: 'Bash', text: 'npm test' },
      { at: '2026-10-02T09:00:05Z', role: 'tool', tool: 'Edit', text: 'src/export.ts' },
      { at: '2026-10-02T09:00:06Z', role: 'agent', text: 'Done: export added.' },
    ]);
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
