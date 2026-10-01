import path from 'node:path';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatSnapshot } from './api-types.js';
import { hasClaudeConversation } from './claude-activity.js';
import { ChatSession, newChatToken, writeMcpConfig, type ChatEvent } from './chat-session.js';
import { mountChatMcpRoutes } from './chat-mcp-routes.js';
import { getConfigDir } from './config.js';
import { latestTranscript } from './context-usage.js';
import { disposePty, peekPty, ptyPids, spawnSpecFor, syncPtyPool } from './pty-pool.js';
import { claudesBySession, readLiveClaudes } from './live-claudes.js';
import { loadHistory, type WorktreeSession } from './history.js';
import { readTranscriptTail } from './transcript.js';
import { findSession } from './web-state.js';

/**
 * A session's Claude as a chat (spike): headless `claude -p` driven by
 * chat-session.ts, instead of the terminal.
 *
 *   GET  /api/sessions/:id/chat                     snapshot (history from the transcript until it runs)
 *   GET  /api/sessions/:id/chat/events              SSE: snapshot, then message / partial / state / permissions
 *   POST /api/sessions/:id/chat/messages            {text, takeOver?} — starts or resumes it
 *   POST /api/sessions/:id/chat/interrupt
 *   POST /api/sessions/:id/chat/permissions/:pid    {allow, message?}
 *
 * One Claude per conversation: while the session's Claude runs in the
 * terminal (PTY host) a message is refused with 409 unless `takeOver`,
 * which stops the terminal's Claude first; the chat then continues the same
 * conversation (--continue).
 */

const HISTORY_BYTES = 1024 * 1024;

export function mountChatRoutes(
  app: Hono,
  opts: { baseUrl: () => string },
): { stopAll: () => void; stop: (id: string) => void; pids: () => number[]; idle: (afterMs: number, now?: number) => string[] } {
  const chats = new Map<string, ChatSession>();
  const byToken = new Map<string, ChatSession>();
  const watchers = new Map<string, Set<(e: ChatEvent | { type: 'snapshot'; snapshot: ChatSnapshot }) => void>>();

  mountChatMcpRoutes(app, { byToken: (t) => byToken.get(t) });

  const historyOf = (session: WorktreeSession): unknown[] => {
    const file = latestTranscript(session)?.file;
    return readTranscriptTail(file, HISTORY_BYTES).filter((e) => {
      if (e.isMeta === true || e.isSidechain === true) return false;
      return e.type === 'user' || e.type === 'assistant' || (e.type === 'system' && e.subtype === 'compact_boundary');
    });
  };

  const snapshotOf = (id: string, session: WorktreeSession): ChatSnapshot => {
    const chat = chats.get(id);
    const base: ChatSnapshot = chat
      ? chat.snapshot()
      : {
          sessionId: id,
          state: 'stopped',
          error: null,
          claudeSessionId: null,
          messages: historyOf(session).map((raw, seq) => ({ seq, raw })),
          partial: null,
          permissions: [],
        };
    return { ...base, terminalRunning: peekPty(id) };
  };

  const chatFor = (id: string, session: WorktreeSession): ChatSession | null => {
    const existing = chats.get(id);
    if (existing) return existing;
    const spec = spawnSpecFor(session);
    if (!spec) return null;
    const token = newChatToken();
    const file = writeMcpConfig(path.join(getConfigDir(), 'chat'), id, `${opts.baseUrl().replace(/\/$/, '')}/api/chat-mcp/${token}`);
    const chat = new ChatSession(
      id,
      { cwd: spec.cwd, cmd: spec.tool.cmd, baseArgs: spec.tool.baseArgs, port: spec.port, continueExisting: hasClaudeConversation(spec.cwd) },
      file,
      historyOf(session),
      token,
    );
    chats.set(id, chat);
    byToken.set(token, chat);
    chat.subscribe((e) => {
      for (const w of watchers.get(id) ?? []) w(e);
    });
    return chat;
  };

  app.get('/api/sessions/:id/chat', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    return c.json(snapshotOf(id, session));
  });

  app.get('/api/sessions/:id/chat/events', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    return streamSSE(c, async (stream) => {
      const send = (e: ChatEvent | { type: 'snapshot'; snapshot: ChatSnapshot }) => {
        stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => { /* gone */ });
      };
      let set = watchers.get(id);
      if (!set) watchers.set(id, (set = new Set()));
      set.add(send);
      send({ type: 'snapshot', snapshot: snapshotOf(id, session) });
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          set!.delete(send);
          resolve();
        });
      });
    });
  });

  app.post('/api/sessions/:id/chat/messages', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; takeOver?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) return c.json({ error: 'text required' }, 400);
    if (!chats.get(id)?.running) {
      // A Claude in a terminal tab on this conversation: we can't stop it for
      // the user, and a second one here would write to the same conversation.
      await syncPtyPool(); // current, not the periodic refresh's
      const hostPids = ptyPids();
      const outside = (claudesBySession(readLiveClaudes(), loadHistory()).get(id) ?? []).filter((x) => !hostPids.has(x.pid));
      if (outside.length > 0) return c.json({ error: 'running-in-terminal' }, 409);
    }
    if (peekPty(id) && !chats.get(id)?.running) {
      if (body?.takeOver !== true) return c.json({ error: 'terminal-running' }, 409);
      await disposePty(id);
    }
    const chat = chatFor(id, session);
    if (!chat) return c.json({ error: 'session has no folder' }, 400);
    chat.send(text);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/chat/interrupt', (c) => {
    const chat = chats.get(c.req.param('id'));
    if (!chat) return c.json({ error: 'not running' }, 404);
    chat.interrupt();
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/chat/permissions/:pid', async (c) => {
    const chat = chats.get(c.req.param('id'));
    if (!chat) return c.json({ error: 'not running' }, 404);
    const body = (await c.req.json().catch(() => null)) as { allow?: unknown; message?: unknown } | null;
    const ok = chat.answer(c.req.param('pid'), body?.allow === true, typeof body?.message === 'string' ? body.message : undefined);
    return ok ? c.json({ ok: true }) : c.json({ error: 'no such prompt (already answered?)' }, 404);
  });

  return {
    stopAll: () => {
      for (const chat of chats.values()) chat.stop();
    },
    stop: (id: string) => chats.get(id)?.stop(),
    pids: () => [...chats.values()].flatMap((c) => (c.pid ? [c.pid] : [])),
    idle: (afterMs, now = Date.now()) => idleChats(chats, (id) => watchers.get(id)?.size ?? 0, afterMs, now),
  };
}

/** Chats to put to sleep: their Claude idle at its prompt for `afterMs`, nobody watching them. */
export function idleChats(
  chats: ReadonlyMap<string, Pick<ChatSession, 'state' | 'lastActivityAt'>>,
  watching: (id: string) => number,
  afterMs: number,
  now: number,
): string[] {
  if (afterMs <= 0) return [];
  return [...chats.entries()].filter(([id, c]) => c.state === 'idle' && now - c.lastActivityAt >= afterMs && watching(id) === 0).map(([id]) => id);
}
