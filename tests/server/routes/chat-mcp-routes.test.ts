import { describe, expect, it, vi } from 'vitest';
import { handleMcp } from '../../../src/server/routes/chat-mcp-routes.js';
import { claudePermissionTool } from '../../../src/core/agents/claude/chat.js';
import type { ChatPermissionTool } from '../../../src/core/agents/types.js';

/** work's MCP permission endpoint: MCP is work's, the tool and its answers the agent's (its protocol's `permissionTool`). */

const textOf = (res: unknown) => JSON.parse((res as { result: { content: Array<{ text: string }> } }).result.content[0].text);

describe('the permission MCP endpoint, with Claude’s tool', () => {
  const chat = { requestPermission: vi.fn(async () => ({ allow: true, input: { command: 'ls' } })) };

  it('introduces itself and lists the agent’s tool', async () => {
    const init = await handleMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      chat,
      claudePermissionTool,
    );
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    const list = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, chat, claudePermissionTool);
    expect(list).toMatchObject({ result: { tools: [{ name: 'approve' }] } });
  });

  it('asks the chat, and answers in the shape Claude expects', async () => {
    const res = await handleMcp(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } },
      },
      chat,
      claudePermissionTool,
    );
    expect(chat.requestPermission).toHaveBeenCalledWith('Bash', { command: 'ls' }, 'toolu_1');
    expect(textOf(res)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    const deny = { requestPermission: vi.fn(async () => ({ allow: false, message: 'not that' })) };
    expect(
      textOf(
        await handleMcp(
          { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { arguments: { tool_name: 'Bash', input: {} } } },
          deny,
          claudePermissionTool,
        ),
      ),
    ).toEqual({ behavior: 'deny', message: 'not that' });
  });

  it('answers nothing to a notification, and an error to an unknown method', async () => {
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, chat, claudePermissionTool)).toBeNull();
    expect(await handleMcp({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, chat, claudePermissionTool)).toMatchObject({
      error: { code: -32601 },
    });
  });
});

describe('the permission MCP endpoint, with another agent’s tool', () => {
  it('lists its tool, reads its arguments and answers in its shape — nothing of Claude’s', async () => {
    const tool: ChatPermissionTool = {
      tool: { name: 'may_i', description: 'Ask first.', inputSchema: { type: 'object' } },
      request: (a) => ({ toolName: String(a.what), input: a.args, toolUseId: null }),
      reply: (d) => ({ verdict: d.allow ? 'yes' : 'no', why: d.message ?? null }),
    };
    const chat = { requestPermission: vi.fn(async () => ({ allow: false, message: 'later' })) };
    expect(await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, chat, tool)).toMatchObject({
      result: { tools: [{ name: 'may_i' }] },
    });
    const res = await handleMcp(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'may_i', arguments: { what: 'Shell', args: { cmd: 'ls' } } } },
      chat,
      tool,
    );
    expect(chat.requestPermission).toHaveBeenCalledWith('Shell', { cmd: 'ls' }, null);
    expect(textOf(res)).toEqual({ verdict: 'no', why: 'later' });
  });
});
