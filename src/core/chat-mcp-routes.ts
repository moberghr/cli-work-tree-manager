import type { Hono } from 'hono';
import type { ChatSession } from './chat-session.js';

/**
 * work's permission endpoint for a headless chat: an MCP tool the agent
 * asks before running a tool (Claude's --permission-prompt-tool
 * mcp__work_chat__approve, agents/claude-chat.ts). A minimal MCP server over
 * HTTP — JSON-RPC in, one JSON response out, no SSE. A tools/call waits until the user answers
 * in the dashboard, then returns the decision (Claude's documented shape):
 * {"behavior":"allow","updatedInput":…} or {"behavior":"deny","message":…}.
 *
 * Called by the agent, not the SPA (so not in the demo's route contract). The
 * path carries the chat session's random token: only the process we
 * started, given that URL in its MCP config, can raise a prompt.
 */
export function mountChatMcpRoutes(app: Hono, opts: { byToken: (token: string) => ChatSession | undefined }): void {
  app.post('/api/chat-mcp/:token', async (c) => {
    const chat = opts.byToken(c.req.param('token'));
    if (!chat) return c.json({ error: 'unknown chat' }, 404);
    const msg = await c.req.json().catch(() => null);
    const res = await handleMcp(msg, chat);
    return res === null ? c.body(null, 202) : c.json(res);
  });
}

export const APPROVE_TOOL = {
  name: 'approve',
  description: 'Ask the user whether a tool call may run.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

/** One JSON-RPC message → its response (null for a notification). */
export async function handleMcp(
  msg: unknown,
  chat: Pick<ChatSession, 'requestPermission'>,
): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
  const m = msg as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  if (m.id === undefined || m.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'work-chat', version: '0.1.0' },
      });
    case 'tools/list':
      return ok({ tools: [APPROVE_TOOL] });
    case 'tools/call': {
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      const toolName = typeof args.tool_name === 'string' ? args.tool_name : 'tool';
      const toolUseId = typeof args.tool_use_id === 'string' ? args.tool_use_id : null;
      const decision = await chat.requestPermission(toolName, args.input ?? {}, toolUseId);
      return ok({ content: [{ type: 'text', text: JSON.stringify(decision) }] });
    }
    case 'ping':
      return ok({});
    default:
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown method ${String(m.method)}` } };
  }
}
