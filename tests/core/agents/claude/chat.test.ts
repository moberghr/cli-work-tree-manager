import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeChat, claudeChatRead, claudeChatRecords, claudePermissionTool, PERMISSION_TOOL, resultText } from '../../../../src/core/agents/claude/chat.js';
import { claudeAgent } from '../../../../src/core/agents/claude/adapter.js';
import { encodeProjectDir } from '../../../../src/core/agents/claude/activity.js';
import { chatItems } from '../../../../src/core/chat/chat-view.js';
import type { WorktreeSession } from '../../../../src/core/sessions/history.js';

/** Claude Code's headless chat protocol, read into work's terms (agents/claude-chat.ts). */

const items = (...raws: unknown[]) => chatItems(raws.map((raw, seq) => ({ seq, records: claudeChatRecords(raw) })));

describe('claudeChatRecords (pure): stream-json lines and transcript entries', () => {
  it('your text and its text; protocol noise gives nothing', () => {
    expect(claudeChatRecords({ type: 'system', subtype: 'init', session_id: 's' })).toEqual([]);
    expect(claudeChatRecords({ type: 'stream_event', event: { type: 'content_block_delta' } })).toEqual([]);
    expect(claudeChatRecords({ type: 'rate_limit_event', rate_limit_info: {} })).toEqual([]);
    expect(items(
      { type: 'user', message: { role: 'user', content: 'Fix the login bug' } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'On it.' }] } },
    ).map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', 'Fix the login bug'],
      ['text', 'On it.'],
    ]);
  });

  it('tool calls and their results, whatever the tool', () => {
    expect(claudeChatRecords({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'SomeNewTool', input: { x: 1 } }] } })).toEqual([{ kind: 'tool', id: 't1', name: 'SomeNewTool', input: { x: 1 } }]);
    expect(claudeChatRecords({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done' }], is_error: true }] } })).toEqual([
      { kind: 'tool-result', toolId: 't1', text: 'done', isError: true },
    ]);
  });

  it('what it does not know comes back raw instead of dropped', () => {
    expect(items(
      { type: 'assistant', message: { content: [{ type: 'brand_new_block', data: 1 }] } },
      { type: 'something_new', payload: true },
      { type: 'system', subtype: 'new_subtype' },
    ).map((i) => (i.kind === 'raw' ? i.label : i.kind))).toEqual(['brand_new_block', 'something_new', 'system new_subtype']);
  });

  it('results, interrupts and compaction become a turn’s end and short lines', () => {
    expect(items(
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 4200, total_cost_usd: 0.02 },
      { type: 'system', subtype: 'compact_boundary' },
    )).toMatchObject([
      { kind: 'notice', text: 'Interrupted' },
      { kind: 'result', ok: true, durationMs: 4200, costUsd: 0.02 },
      { kind: 'notice', text: 'Conversation compacted' },
    ]);
  });

  it('skips meta and subagent entries', () => {
    expect(claudeChatRecords({ type: 'user', isMeta: true, message: { content: 'caveat' } })).toEqual([]);
    expect(claudeChatRecords({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } })).toEqual([]);
  });

  it('a `!` command’s tagged text is split out, without terminal colour codes', () => {
    expect(items(
      { type: 'user', message: { content: '<bash-input>wd</bash-input>' } },
      { type: 'user', message: { content: '<bash-stdout>\u001b[90mShowing uncommitted changes vs HEAD.\u001b[39m</bash-stdout><bash-stderr></bash-stderr>' } },
      { type: 'user', message: { content: 'Look at this <custom-tag>x</custom-tag> please' } },
    )).toMatchObject([
      { kind: 'tagged', parts: [{ tag: 'bash-input', text: 'wd' }] },
      { kind: 'tagged', parts: [{ tag: 'bash-stdout', text: 'Showing uncommitted changes vs HEAD.' }, { tag: 'bash-stderr', text: '' }] },
      { kind: 'tagged', parts: [{ tag: 'custom-tag', text: 'x' }] },
      { kind: 'user', text: 'Look at this  please' },
    ]);
  });

  it('reads tool results as text', () => {
    expect(resultText('plain')).toBe('plain');
    expect(resultText('\u001b[32mok\u001b[39m')).toBe('ok');
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe('a\n[image]');
  });
});

describe('claudeChatRead (pure): what a line says about the run', () => {
  it('init: ready, with its conversation', () => {
    expect(claudeChatRead({ type: 'system', subtype: 'init', session_id: 'c1' })).toEqual({ records: [], ready: true, conversationId: 'c1' });
  });
  it('a result ends the turn; its messages are activity; an ack acknowledges', () => {
    expect(claudeChatRead({ type: 'result', subtype: 'success' })).toMatchObject({ turnEnded: true, records: [{ kind: 'turn-end' }] });
    expect(claudeChatRead({ type: 'assistant', message: { content: 'x' } })).toMatchObject({ activity: true });
    expect(claudeChatRead({ type: 'control_response', response: {} })).toEqual({ records: [], acknowledged: true });
  });
  it('streamed text: a block starts, grows, stops', () => {
    expect(claudeChatRead({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } }).stream).toEqual({ start: 'thinking' });
    expect(claudeChatRead({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } }).stream).toEqual({ start: null });
    expect(claudeChatRead({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'Hi' } } }).stream).toEqual({ delta: 'Hi' });
    expect(claudeChatRead({ type: 'stream_event', event: { type: 'message_stop' } }).stream).toEqual({ stop: true });
  });
});

describe('claudeChat.open: the process and its lines', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-chat-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs headless with work’s permission tool, resuming or continuing', () => {
    const p = claudeChat.open({ sessionId: 's1', permissionUrl: 'http://127.0.0.1:1/api/chat-mcp/tok', dir });
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 's1.mcp.json'), 'utf8'));
    expect(cfg).toEqual({ mcpServers: { work_chat: { type: 'http', url: 'http://127.0.0.1:1/api/chat-mcp/tok' } } });
    const first = p.args({ resumeId: null, continueLatest: true });
    expect(first).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', PERMISSION_TOOL, '--mcp-config', path.join(dir, 's1.mcp.json'), '--continue']));
    expect(p.args({ resumeId: 'c9', continueLatest: true })).toEqual(expect.arrayContaining(['--resume', 'c9']));
    expect(p.args({ resumeId: null, continueLatest: false })).not.toContain('--continue');
    expect(p.userLine('hi')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(p.interruptLine()).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect(claudeAgent.chat).toBe(claudeChat);
    expect(p.permissionTool).toBe(claudePermissionTool); // asked at the URL it was given
  });

  it('its history: the newest transcript’s messages, not its file snapshots or summaries', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    const wt = path.join(dir, 'wt');
    const projects = path.join(dir, '.claude', 'projects', encodeProjectDir(wt));
    fs.mkdirSync(projects, { recursive: true });
    const lines = [
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'summary', summary: 'x' },
      { type: 'user', message: { role: 'user', content: 'Add a test' }, timestamp: '2026-10-01T10:00:00Z' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Added.' }] }, timestamp: '2026-10-01T10:01:00Z' },
    ];
    fs.writeFileSync(path.join(projects, 'c1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const s = { target: 'api', branch: 'feat/x', paths: [wt], isGroup: false } as WorktreeSession;
    expect(claudeChat.history(s)).toEqual([[{ kind: 'you', text: 'Add a test' }], [{ kind: 'text', text: 'Added.' }]]);
  });
});

describe('tool calls without an id', () => {
  it('get none (nothing can name them), and each still has its own card', () => {
    const idless = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
    expect(claudeChatRecords(idless)).toEqual([{ kind: 'tool', id: '', name: 'Bash', input: { command: 'ls' } }]);
    const its = items(idless, idless, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '', content: 'x' }] } });
    const tools = its.filter((i) => i.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((t) => (t as { id: string }).id)).size).toBe(2); // two cards, two ids
    expect(tools.every((t) => (t as { result: unknown }).result === null)).toBe(true); // nothing paired with either
  });
});

describe('claudePermissionTool: Claude’s --permission-prompt-tool contract', () => {
  it('reads what Claude sends, and answers allow / deny its way', () => {
    expect(claudePermissionTool.request({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' })).toEqual({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 't1' });
    expect(claudePermissionTool.request({})).toEqual({ toolName: 'tool', input: {}, toolUseId: null });
    expect(claudePermissionTool.reply({ allow: true, input: { command: 'ls' } })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(claudePermissionTool.reply({ allow: false })).toEqual({ behavior: 'deny', message: 'The user denied this.' });
    expect(claudePermissionTool.tool.name).toBe('approve'); // `mcp__work_chat__approve` with the server name
  });
});
