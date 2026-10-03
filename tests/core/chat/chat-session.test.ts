import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_HISTORY_BYTES, ChatSession, type ChatEvent } from '../../../src/core/chat/chat-session.js';
import { claudeChat } from '../../../src/core/agents/claude/chat.js';
import type { ChatProtocol } from '../../../src/core/agents/types.js';
import type { ChatRecord } from '../../../src/core/chat/chat-view.js';
import { isAlive, killTree, runAll } from '../../functional/fixtures/processes.js';

const FAKE = path.join(path.join(__dirname, '..'), 'fixtures', 'fake-claude-stream.cjs');
const FAKE_ECHO = path.join(path.join(__dirname, '..'), 'fixtures', 'fake-echo-chat.cjs');

let dir: string;
let pidsFile: string;
const chats: ChatSession[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-session-'));
  pidsFile = path.join(dir, 'pids');
  process.env.FAKE_CLAUDE_PIDS = pidsFile;
});

afterEach(async () => {
  await runAll([
    ...chats.splice(0).map((c) => () => c.stop()),
    async () => {
      const pids = fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];
      for (const p of pids) killTree(p);
      // The fake runs with this folder as its cwd: on Windows the folder can't
      // go until it has exited (a flake under load: EPERM in cleanup).
      const end = Date.now() + 5_000;
      while (pids.some(isAlive) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    },
    () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  ]);
  delete process.env.FAKE_CLAUDE_PIDS;
});

/** A chat on the fake; `args` records what each start was given by the protocol. */
function make(
  history: ChatRecord[][] = [],
  protocol?: ChatProtocol,
  script = FAKE,
): { chat: ChatSession; events: ChatEvent[]; args: string[][] } {
  const base = protocol ?? claudeChat.open({ sessionId: 's1', permissionUrl: 'http://127.0.0.1:1/api/chat-mcp/t', dir });
  const args: string[][] = [];
  const p: ChatProtocol = {
    ...base,
    args: (o) => {
      const a = base.args(o);
      args.push(a);
      return a;
    },
  };
  const chat = new ChatSession('s1', { cwd: dir, cmd: process.execPath, baseArgs: [script], continueExisting: true }, p, history);
  chats.push(chat);
  const events: ChatEvent[] = [];
  chat.subscribe((e) => events.push(e));
  return { chat, events, args };
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const kinds = (chat: ChatSession) => chat.snapshot().messages.flatMap((m) => m.records.map((r) => r.kind));

describe('ChatSession running Claude’s protocol (stream-json)', () => {
  it('starts on the first message, streams the reply, and is idle after the result', async () => {
    const { chat, events, args } = make([[{ kind: 'you', text: 'earlier' }]]);
    expect(chat.state).toBe('stopped');
    chat.send('hello');
    await until(() => chat.state === 'idle' && kinds(chat).includes('turn-end'));
    expect(kinds(chat)).toEqual(['you', 'you', 'text', 'turn-end']); // history first; the init line shows nothing
    expect(chat.conversationId).toBe('fake-session-1');
    const partials = events.flatMap((e) => (e.type === 'partial' && e.partial ? [e.partial.text] : []));
    expect(partials.at(-1)).toBe('Hi there');
    expect(chat.snapshot().partial).toBeNull();
    // Launched headless with the permission tool, continuing the folder's conversation.
    expect(args[0]).toEqual(
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--permission-prompt-tool',
        'mcp__work_chat__approve',
        '--continue',
      ]),
    );
  });

  it('interrupts with a control request, and resumes the same conversation after a stop', async () => {
    const { chat, args } = make();
    chat.send('slow');
    await until(() => chat.state === 'working');
    chat.interrupt();
    await until(() => chat.state === 'idle');
    expect(chat.running).toBe(true); // acknowledged: the process stays

    chat.stop();
    await until(() => !chat.running);
    expect(chat.state).toBe('stopped');
    chat.send('hello');
    await until(() => chat.state === 'idle' && kinds(chat).filter((t) => t === 'turn-end').length === 2);
    expect(args.at(-1)).toEqual(expect.arrayContaining(['--resume', 'fake-session-1']));
  });

  it('stops a process that ignores the interrupt', async () => {
    const { chat } = make();
    chat.send('ignore-interrupt');
    await until(() => chat.state === 'working');
    chat.interrupt();
    await until(() => !chat.running, 12_000);
    expect(chat.state).toBe('stopped');
  }, 20_000);

  it('holds a permission prompt until the user answers', async () => {
    const { chat } = make();
    chat.send('slow');
    await until(() => chat.state === 'working');
    const decision = chat.requestPermission('Bash', { command: 'rm -rf build' }, 'toolu_9');
    expect(chat.state).toBe('needs_input');
    const [p] = chat.snapshot().permissions;
    expect(p).toMatchObject({ toolName: 'Bash', toolUseId: 'toolu_9' });
    expect(chat.answer(p.id, false, 'not that folder')).toBe(true);
    await expect(decision).resolves.toEqual({ allow: false, message: 'not that folder' }); // work's terms; the protocol encodes it
    expect(chat.snapshot().permissions).toEqual([]);
    expect(chat.answer(p.id, true)).toBe(false); // already answered
  });
});

describe('ChatSession memory', () => {
  it('keeps the history under its size cap (oldest go first, never below the last 50)', () => {
    const big = 'x'.repeat(300_000);
    const history: ChatRecord[][] = Array.from({ length: 100 }, (_, i) => [{ kind: 'you', text: `${i} ${big}` }]);
    const { chat } = make(history);
    const kept = chat.snapshot().messages;
    const bytes = kept.reduce((n, m) => n + JSON.stringify(m.records).length, 0);
    expect(bytes).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    expect(kept.length).toBeGreaterThanOrEqual(50);
    expect((kept[kept.length - 1].records[0] as { text: string }).text.startsWith('99 ')).toBe(true); // the newest stay
    const few = make(Array.from({ length: 10 }, (): ChatRecord[] => [{ kind: 'you', text: 'x'.repeat(5_000_000) }])).chat;
    expect(few.snapshot().messages).toHaveLength(10); // under 50: kept, however big
  });

  it('knows when it was last active', () => {
    const before = Date.now();
    const { chat } = make();
    expect(chat.lastActivityAt).toBeGreaterThanOrEqual(before);
  });
});

/**
 * Another agent's protocol (tests/core/fixtures/fake-echo-chat.cjs): its own
 * lines, a permission asked in its output, no interrupt. The same
 * ChatSession runs it — nothing in it is Claude's.
 */
const echoProtocol = (): ChatProtocol => ({
  args: ({ resumeId }) => ['--echo', ...(resumeId ? ['--again', resumeId] : [])],
  userLine: (text) => ({ say: text }),
  interruptLine: () => null,
  read(raw) {
    const m = raw as { hello?: string; said?: string; done?: boolean; asks?: { id: string; tool: string; input: unknown } };
    if (m.hello) return { records: [], ready: true, conversationId: m.hello };
    if (typeof m.said === 'string') return { records: [{ kind: 'text', text: m.said }], activity: true };
    if (m.done) return { records: [{ kind: 'turn-end', ok: true, subtype: 'done', durationMs: null, costUsd: null }], turnEnded: true };
    if (m.asks)
      return {
        records: [{ kind: 'tool', id: m.asks.id, name: m.asks.tool, input: m.asks.input }],
        permission: { requestId: m.asks.id, toolName: m.asks.tool, input: m.asks.input, toolUseId: m.asks.id },
      };
    return { records: [{ kind: 'raw', label: 'echo', raw }] };
  },
  answerLine: (requestId, d) => ({ answer: requestId, allow: d.allow }),
});

describe('ChatSession running another agent’s protocol', () => {
  it('its lines, its turn end, its conversation id', async () => {
    const { chat, args } = make([], echoProtocol(), FAKE_ECHO);
    chat.send('ping');
    await until(() => chat.state === 'idle' && kinds(chat).includes('turn-end'));
    expect(chat.snapshot().messages.flatMap((m) => m.records)).toEqual([
      { kind: 'text', text: 'ping' },
      { kind: 'turn-end', ok: true, subtype: 'done', durationMs: null, costUsd: null },
    ]);
    expect(chat.conversationId).toBe('echo-conv-1');
    expect(args).toEqual([['--echo']]);
  });

  it('a permission asked in its own output is held, and answered on its stdin', async () => {
    const { chat } = make([], echoProtocol(), FAKE_ECHO);
    chat.send('ask');
    await until(() => chat.snapshot().permissions.length === 1);
    expect(chat.state).toBe('needs_input');
    const [p] = chat.snapshot().permissions;
    expect(p).toMatchObject({ toolName: 'Shell', input: { cmd: 'ls' }, toolUseId: 'r1' });
    expect(chat.answer(p.id, true)).toBe(true);
    await until(() => chat.state === 'idle' && kinds(chat).includes('turn-end'));
    expect(
      chat
        .snapshot()
        .messages.flatMap((m) => m.records)
        .find((r) => r.kind === 'text'),
    ).toEqual({ kind: 'text', text: 'allowed' });
  });

  it('no interrupt in its protocol: an interrupt stops the process, the next message starts it again', async () => {
    const { chat, args } = make([], echoProtocol(), FAKE_ECHO);
    chat.send('hang');
    await until(() => chat.state === 'working');
    chat.interrupt();
    await until(() => !chat.running, 12_000);
    expect(chat.state).toBe('stopped');
    chat.send('again');
    await until(() => chat.state === 'idle' && kinds(chat).includes('turn-end'));
    expect(args.at(-1)).toEqual(['--echo', '--again', 'echo-conv-1']); // resumed its conversation
  }, 20_000);
});

describe('ChatSession after a stop (it never writes to a closed stdin)', () => {
  it('a permission asked in its output, then a stop: the denial is not written, and nothing throws', async () => {
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onErr);
    try {
      const { chat } = make([], echoProtocol(), FAKE_ECHO);
      chat.send('ask');
      await until(() => chat.snapshot().permissions.length === 1);
      chat.interrupt(); // no interrupt in its protocol: denies the prompt, then stops
      await until(() => !chat.running, 12_000);
      await new Promise((r) => setTimeout(r, 100));
      expect(chat.state).toBe('stopped');
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onErr);
    }
  }, 20_000);

  it('a message right after a stop goes to a fresh process, and the old one’s exit doesn’t touch it', async () => {
    const { chat, args } = make();
    chat.send('hello');
    await until(() => chat.state === 'idle' && kinds(chat).includes('turn-end'));
    chat.stop();
    chat.send('hello'); // the old one is still exiting
    await until(() => chat.state === 'idle' && kinds(chat).filter((k) => k === 'turn-end').length === 2);
    expect(args).toHaveLength(2);
    expect(args[1]).toEqual(expect.arrayContaining(['--resume', 'fake-session-1']));
    await new Promise((r) => setTimeout(r, 1800)); // past the stop's kill timer and the old one's exit
    expect(chat.running).toBe(true);
    expect(chat.state).toBe('idle');
  }, 20_000);

  it('a permission it can’t answer (no answerLine) is said in the chat, not left hanging unseen', async () => {
    const { answerLine: _none, ...noAnswer } = echoProtocol();
    const { chat } = make([], noAnswer, FAKE_ECHO);
    chat.send('ask');
    await until(() => kinds(chat).includes('notice'));
    expect(chat.snapshot().permissions).toEqual([]);
    expect(
      chat
        .snapshot()
        .messages.flatMap((m) => m.records)
        .find((r) => r.kind === 'notice'),
    ).toMatchObject({ text: expect.stringContaining('Shell') });
  });
});
