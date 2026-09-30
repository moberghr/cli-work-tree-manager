import { describe, expect, it, vi } from 'vitest';
import { APPROVE_TOOL, handleMcp } from '../../src/core/chat-mcp-routes.js';

describe('the permission MCP tool', () => {
  const chat = { requestPermission: vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: { command: 'ls' } })) };

  it('introduces itself and lists the approve tool', async () => {
    const init = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, chat);
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    const list = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, chat);
    expect(list).toMatchObject({ result: { tools: [APPROVE_TOOL] } });
  });

  it('asks the chat and answers in the shape Claude expects', async () => {
    const res = await handleMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } },
    }, chat);
    expect(chat.requestPermission).toHaveBeenCalledWith('Bash', { command: 'ls' }, 'toolu_1');
    const text = (res as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    expect(JSON.parse(text)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('answers nothing to a notification, and an error to an unknown method', async () => {
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, chat)).toBeNull();
    expect(await handleMcp({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, chat)).toMatchObject({ error: { code: -32601 } });
  });
});
