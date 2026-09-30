import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatSession, type ChatEvent } from '../../src/core/chat-session.js';
import { killTree, runAll } from '../functional/fixtures/processes.js';

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude-stream.cjs');

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
    () => {
      const pids = fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean) : [];
      for (const p of pids) killTree(Number(p));
    },
    () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  ]);
  delete process.env.FAKE_CLAUDE_PIDS;
});

function make(history: unknown[] = []): { chat: ChatSession; events: ChatEvent[] } {
  const chat = new ChatSession('s1', { cwd: dir, cmd: process.execPath, baseArgs: [FAKE], continueExisting: true }, path.join(dir, 'mcp.json'), history);
  chats.push(chat);
  const events: ChatEvent[] = [];
  chat.subscribe((e) => events.push(e));
  return { chat, events };
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const types = (chat: ChatSession) => chat.snapshot().messages.map((m) => (m.raw as { type: string }).type);

describe('ChatSession (headless Claude over stream-json)', () => {
  it('starts on the first message, streams the reply, and is idle after the result', async () => {
    const { chat, events } = make([{ type: 'user', message: { content: 'earlier' } }]);
    expect(chat.state).toBe('stopped');
    chat.send('hello');
    await until(() => chat.state === 'idle' && types(chat).includes('result'));
    expect(types(chat)).toEqual(['user', 'system', 'user', 'assistant', 'result']); // history first
    expect(chat.claudeSessionId).toBe('fake-session-1');
    const partials = events.flatMap((e) => (e.type === 'partial' && e.partial ? [e.partial.text] : []));
    expect(partials.at(-1)).toBe('Hi there');
    expect(chat.snapshot().partial).toBeNull();
    // Launched headless with the permission tool, continuing the folder's conversation.
    const argv = (chat.snapshot().messages[1].raw as { argv: string[] }).argv;
    expect(argv).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'mcp__work_chat__approve', '--continue']));
  });

  it('interrupts with a control request, and resumes the same conversation after a stop', async () => {
    const { chat } = make();
    chat.send('slow');
    await until(() => chat.state === 'working');
    chat.interrupt();
    await until(() => chat.state === 'idle');
    expect(chat.running).toBe(true); // acknowledged: the process stays

    chat.stop();
    await until(() => !chat.running);
    expect(chat.state).toBe('stopped');
    chat.send('hello');
    await until(() => chat.state === 'idle' && types(chat).filter((t) => t === 'result').length === 2);
    const inits = chat.snapshot().messages.filter((m) => (m.raw as { subtype?: string }).subtype === 'init');
    expect((inits.at(-1)!.raw as { argv: string[] }).argv).toEqual(expect.arrayContaining(['--resume', 'fake-session-1']));
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
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'not that folder' });
    expect(chat.snapshot().permissions).toEqual([]);
    expect(chat.answer(p.id, true)).toBe(false); // already answered
  });
});
