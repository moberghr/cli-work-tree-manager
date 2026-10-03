import type { Hono } from 'hono';
import type { ChatSession } from '../../core/chat/chat-session.js';
import type { ChatPermissionTool } from '../../core/agents/types.js';

/**
 * work's permission endpoint for a headless chat: a minimal MCP server over
 * HTTP — JSON-RPC in, one JSON response out, no SSE — serving the one tool
 * the chat's agent asks before running anything. What that tool is called,
 * what it is sent and what it answers are the agent's (its protocol's
 * `permissionTool`; Claude's --permission-prompt-tool: agents/claude-chat.ts):
 * this speaks MCP and waits for the user. A tools/call holds until the user
 * answers in the dashboard.
 *
 * Called by the agent, not the SPA (so not in the demo's route contract).
 * The path carries the chat session's random token: only the process we
 * started, given that URL, can raise a prompt.
 */
export function mountChatMcpRoutes(app: Hono, opts: { byToken: (token: string) => ChatSession | undefined }): void {
  app.post('/api/chat-mcp/:token', async (c) => {
    const chat = opts.byToken(c.req.param('token'));
    const tool = chat?.permissionTool;
    if (!chat || !tool) return c.json({ error: 'unknown chat' }, 404);
    const msg = await c.req.json().catch(() => null);
    const res = await handleMcp(msg, chat, tool);
    return res === null ? c.body(null, 202) : c.json(res);
  });
}

/** One JSON-RPC message → its response (null for a notification). */
export async function handleMcp(
  msg: unknown,
  chat: Pick<ChatSession, 'requestPermission'>,
  tool: ChatPermissionTool,
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
      return ok({ tools: [tool.tool] });
    case 'tools/call': {
      const args = m.params?.arguments && typeof m.params.arguments === 'object' ? (m.params.arguments as Record<string, unknown>) : {};
      const asked = tool.request(args);
      const decision = await chat.requestPermission(asked.toolName, asked.input, asked.toolUseId);
      return ok({ content: [{ type: 'text', text: JSON.stringify(tool.reply(decision)) }] });
    }
    case 'ping':
      return ok({});
    default:
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown method ${String(m.method)}` } };
  }
}
