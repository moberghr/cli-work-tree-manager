import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeProjectDir } from '../../../src/core/agents/claude/activity.js';
import { resetWorkTimeCache, sessionTokens, sessionWorkTime } from '../../../src/core/conversations/work-time-source.js';
import { dayKey } from '../../../src/core/conversations/work-time-view.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** Transcripts in a temp HOME: tokens by local day and model, once per API message, read incrementally; work time as before. */

let home: string;
let file: string;
let session: WorktreeSession;
const T0 = new Date(2026, 9, 28, 10, 0, 0).getTime(); // local time: the day key is local
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const assistant = (s: number, id: string | undefined, usage: Record<string, number>, model = 'claude-opus-5-5', text = 'x') => ({
  type: 'assistant',
  timestamp: at(s),
  message: { ...(id ? { id } : {}), model, usage, content: [{ type: 'text', text }] },
});
const write = (lines: unknown[], append = false) => {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-time-source-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(wt));
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'c.jsonl');
  session = { target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: at(0), lastAccessedAt: at(0) };
  resetWorkTimeCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('sessionTokens', () => {
  it('counts tokens per local day and model, the cached part apart from the input', async () => {
    write([
      assistant(0, 'm1', { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 }),
      assistant(60, 'm2', { input_tokens: 10, output_tokens: 5 }, 'claude-haiku-4-5'),
      // The next local day.
      { ...assistant(0, 'm3', { input_tokens: 7, output_tokens: 3 }), timestamp: new Date(T0 + 24 * 3600_000).toISOString() },
    ]);
    const t = await sessionTokens(session, '2026-01-01');
    const d1 = dayKey(T0);
    const d2 = dayKey(T0 + 24 * 3600_000);
    expect(t[d1]!['claude-opus-5-5']).toEqual({ input: 150, cached: 900, output: 20 });
    expect(t[d1]!['claude-haiku-4-5']).toEqual({ input: 10, cached: 0, output: 5 });
    expect(t[d2]!['claude-opus-5-5']).toEqual({ input: 7, cached: 0, output: 3 });
  });

  it('takes a message’s usage once, however many lines it was written as', async () => {
    const u = { input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 30 };
    write([assistant(0, 'm1', u), assistant(1, 'm1', u), assistant(2, 'm1', u), assistant(3, 'm2', u)]);
    const t = await sessionTokens(session, '2026-01-01');
    expect(t[dayKey(T0)]!['claude-opus-5-5']).toEqual({ input: 200, cached: 800, output: 60 });
  });

  it('counts lines without a message id each, and a model-less line as unknown', async () => {
    write([assistant(0, undefined, { input_tokens: 1, output_tokens: 1 }), assistant(1, undefined, { input_tokens: 1, output_tokens: 1 })]);
    const line = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]!);
    delete line.message.model;
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
    const t = (await sessionTokens(session, '2026-01-01'))[dayKey(T0)]!;
    expect(t['claude-opus-5-5']).toEqual({ input: 2, cached: 0, output: 2 });
    expect(t['unknown']).toEqual({ input: 1, cached: 0, output: 1 });
  });

  it('counts a subagent’s usage too', async () => {
    write([{ ...assistant(0, 'm1', { input_tokens: 40, output_tokens: 4 }), isSidechain: true }]);
    expect((await sessionTokens(session, '2026-01-01'))[dayKey(T0)]!['claude-opus-5-5']).toEqual({ input: 40, cached: 0, output: 4 });
  });

  it("counts its subagents' transcripts (<conversation>/subagents/agent-*.jsonl); work time reads the conversation alone", async () => {
    write([
      { type: 'user', timestamp: at(0), uuid: 'u1', message: { role: 'user', content: 'go' } },
      assistant(60, 'm1', { input_tokens: 10, output_tokens: 1 }),
    ]);
    const sub = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const agentLine = (s: number, id: string) => ({ ...assistant(s, id, { input_tokens: 100, output_tokens: 7 }), isSidechain: true });
    fs.writeFileSync(
      path.join(sub, 'agent-a1.jsonl'),
      [agentLine(5, 's1'), agentLine(500, 's2')].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), '{}');
    const before = await sessionWorkTime(session, T0 + 3600_000);
    expect((await sessionTokens(session, '2026-01-01'))[dayKey(T0)]!['claude-opus-5-5']).toEqual({ input: 210, cached: 0, output: 15 });
    const after = await sessionWorkTime(session, T0 + 3600_000);
    expect(after).toEqual(before);
    expect(after.workedMs).toBe(60_000);
  });

  it('does not read a file last written before `sinceDay` began (local midnight)', async () => {
    write([assistant(0, 'm1', { input_tokens: 1, output_tokens: 1 })]);
    const lateBefore = new Date(2026, 9, 27, 23, 30);
    fs.utimesSync(file, lateBefore, lateBefore);
    const open = vi.spyOn(fs.promises, 'open');
    expect(await sessionTokens(session, '2026-10-28')).toEqual({});
    expect(open).not.toHaveBeenCalled();
    const justAfter = new Date(2026, 9, 28, 0, 30);
    fs.utimesSync(file, justAfter, justAfter);
    await sessionTokens(session, '2026-10-28');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves out days before `sinceDay`', async () => {
    write([assistant(0, 'm1', { input_tokens: 1, output_tokens: 1 })]);
    expect(await sessionTokens(session, dayKey(T0 + 24 * 3600_000))).toEqual({});
  });

  it('reads only what was appended, and a message split across the two reads still counts once', async () => {
    const u = { input_tokens: 100, output_tokens: 10 };
    write([assistant(0, 'm1', u)]);
    expect((await sessionTokens(session, '2026-01-01'))[dayKey(T0)]!['claude-opus-5-5']).toEqual({ input: 100, cached: 0, output: 10 });
    write([assistant(1, 'm1', u), assistant(2, 'm2', u)], true);
    expect((await sessionTokens(session, '2026-01-01'))[dayKey(T0)]!['claude-opus-5-5']).toEqual({ input: 200, cached: 0, output: 20 });
  });

  it('reads a file once for tokens and work time together', async () => {
    write([
      { type: 'user', timestamp: at(0), uuid: 'u1', message: { role: 'user', content: 'go' } },
      assistant(120, 'm1', { input_tokens: 5, output_tokens: 1 }),
    ]);
    const open = vi.spyOn(fs.promises, 'open');
    await sessionTokens(session, '2026-01-01');
    await sessionWorkTime(session);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('sessionWorkTime', () => {
  it('is unchanged by the token counting', async () => {
    write([
      { type: 'user', timestamp: at(0), uuid: 'u1', message: { role: 'user', content: 'go' } },
      assistant(120, 'm1', { input_tokens: 5, output_tokens: 1 }),
      assistant(180, 'm1', { input_tokens: 5, output_tokens: 1 }),
    ]);
    const w = await sessionWorkTime(session, T0 + 3600_000);
    expect(w.prompts).toBe(1);
    expect(w.workedMs).toBe(180_000);
    expect(w.firstAt).toBe(at(0));
  });
});
