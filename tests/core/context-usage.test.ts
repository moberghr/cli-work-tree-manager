import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { contextUsageFrom, readContextUsage, DEFAULT_WINDOW, LARGE_WINDOW } from '../../src/core/context-usage.js';
import { encodeProjectDir } from '../../src/core/claude-activity.js';
import type { TranscriptEntry } from '../../src/core/transcript.js';
import type { WorktreeSession } from '../../src/core/session-types.js';

const reply = (usage: Record<string, number>, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  type: 'assistant',
  message: { model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'ok' }] },
  ...extra,
});

describe('contextUsageFrom', () => {
  it("is the newest reply's prompt (input + cache reads + cache writes) plus its output", () => {
    const u = contextUsageFrom([
      reply({ input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 5 }),
      { type: 'user', message: { content: 'next' } },
      reply({ input_tokens: 20, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000, output_tokens: 300 }),
    ]);
    expect(u).toEqual({ used: 52_320, window: DEFAULT_WINDOW, model: 'claude-sonnet-5' });
  });

  it("skips subagent turns (they have their own context) and entries without usage", () => {
    const u = contextUsageFrom([
      reply({ input_tokens: 40_000 }),
      reply({ input_tokens: 190_000 }, { isSidechain: true }),
      { type: 'assistant', message: { content: 'no usage' } },
    ]);
    expect(u?.used).toBe(40_000);
    expect(contextUsageFrom([{ type: 'user', message: { content: 'hi' } }])).toBeNull();
  });

  it('recognises the 1M-token window', () => {
    expect(contextUsageFrom([reply({ input_tokens: 300_000 })])?.window).toBe(LARGE_WINDOW);
    const m = contextUsageFrom([{ type: 'assistant', message: { model: 'claude-opus-5-5[1m]', usage: { input_tokens: 5 } } }]);
    expect(m?.window).toBe(LARGE_WINDOW);
  });
});

describe('readContextUsage', () => {
  let home: string;
  let wt: string;
  let file: string;
  const session = (): WorktreeSession => ({
    target: 'api', branch: 'feat/x', isGroup: false, paths: [wt],
    createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
  });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-usage-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    wt = path.join(home, 'wt', 'api');
    fs.mkdirSync(wt, { recursive: true });
    const dir = path.join(home, '.claude', 'projects', encodeProjectDir(wt));
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'conv.jsonl');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const append = (e: TranscriptEntry) => fs.appendFileSync(file, JSON.stringify(e) + '\n');

  it("reads the session's transcript, and follows it as it grows", () => {
    expect(readContextUsage(session())).toBeNull(); // no reply yet
    append(reply({ input_tokens: 1000 }));
    expect(readContextUsage(session())?.used).toBe(1000);
    append(reply({ input_tokens: 150_000 }));
    expect(readContextUsage(session())?.used).toBe(150_000);
  });

  it('null when Claude never ran there', () => {
    fs.rmSync(path.dirname(file), { recursive: true });
    expect(readContextUsage(session())).toBeNull();
  });
});
