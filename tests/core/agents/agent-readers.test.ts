import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeProjectDir } from '../../../src/core/agents/claude/activity.js';
import { readContextUsage } from '../../../src/core/conversations/context-usage.js';
import { sessionTitle } from '../../../src/core/conversations/session-title.js';
import { resetWorkTimeCache, sessionWorkTime } from '../../../src/core/conversations/work-time-source.js';
import { sessionTimeline } from '../../../src/core/conversations/timeline-source.js';
import { cachedCatchUp, catchUp } from '../../../src/core/conversations/catch-up.js';
import { searchConversations, syncConversation } from '../../../src/core/conversations/conversation-store.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import { readSessionActivity } from '../../../src/core/sessions/session-activity.js';
import { saveConfig } from '../../../src/core/platform/config.js';
import { sessionStatusView } from '../../../src/core/status/turn-activity.js';

/**
 * Every reader of a session's conversation asks the session's agent
 * (agents/): context usage, title, work time, timeline, catch-up, search.
 * A session running an agent work has no reader for gets none of it — not
 * Claude's files read as if they were its.
 */

let home: string;
let wt: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-readers-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  // A Claude transcript in the folder: a prompt and a reply with usage.
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(wt));
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const at = (ms: number) => new Date(now - ms).toISOString();
  fs.writeFileSync(
    path.join(dir, 'c.jsonl'),
    [
      { type: 'user', timestamp: at(120_000), uuid: 'u1', message: { role: 'user', content: 'Add the CSV export' } },
      { type: 'assistant', timestamp: at(60_000), message: { model: 'claude-sonnet-5', usage: { input_tokens: 5000, output_tokens: 100 }, content: [{ type: 'text', text: 'Added the CSV export.' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  resetWorkTimeCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const session = (agent?: string): WorktreeSession => ({
  target: 'api', branch: agent ? `feat/${agent}` : 'feat/x', isGroup: false, paths: [wt],
  createdAt: new Date(Date.now() - 3600_000).toISOString(), lastAccessedAt: new Date().toISOString(),
  ...(agent ? { agent } : {}),
});

describe('the session’s agent decides what its conversation is', () => {
  it('Claude’s session: read through Claude’s adapter', async () => {
    const s = session();
    expect(readContextUsage(s)).toMatchObject({ used: 5100, window: 200_000 });
    expect(sessionTitle(s)).toBe('Add the CSV export');
    expect((await sessionWorkTime(s)).prompts).toBe(1);
    expect((await sessionTimeline(s, { run: async () => ({ code: 1, stdout: '', stderr: '' }) })).some((e) => e.kind === 'prompt')).toBe(true);
  });

  it('a session running an agent work can’t read: none of it, even with Claude’s files in its folder', async () => {
    // The configured agent is opencode (work has no adapter for it, so the session follows aiCommand).
    saveConfig({ worktreesRoot: path.join(home, 'wt'), repos: {}, groups: {}, copyFiles: [], aiCommand: 'opencode' });
    const s = session();
    expect(readContextUsage(s)).toBeNull();
    expect(sessionTitle(s)).toBeNull();
    expect(await sessionWorkTime(s)).toMatchObject({ prompts: 0, workedMs: 0 });
    expect((await sessionTimeline(s, { run: async () => ({ code: 1, stdout: '', stderr: '' }) })).some((e) => e.kind === 'prompt')).toBe(false);
    const ask = vi.fn(async () => 'summary');
    expect(await catchUp(s, ask)).toBeNull(); // nothing to go on
    expect(ask).not.toHaveBeenCalled();
    expect(cachedCatchUp(s)).toBeNull();
    const root = path.join(home, '.work', 'conversations');
    expect(await syncConversation(s, root)).toEqual({ files: 0, bytes: 0 });
    expect(await searchConversations('CSV export', { sessions: [s], root, archive: path.join(home, 'archive') })).toEqual([]);
    // Nor its activity, nor "a turn's message after the turn ended" (turn activity).
    expect(readSessionActivity(s)).toEqual({ lastActivity: null, state: 'stale' });
    const idle = { state: 'idle' as const, seen: true, since: new Date(Date.now() - 3600_000).toISOString(), updatedAt: new Date(Date.now() - 3600_000).toISOString(), turnEndedAt: new Date(Date.now() - 3600_000).toISOString() };
    expect(sessionStatusView(idle, s, Date.now()).state).toBe('idle');
    // …while a session created with Claude keeps reading its transcript: a reply after the turn ended reads as working.
    const claudes = session('claude');
    expect(readSessionActivity(claudes).lastActivity).toBeGreaterThan(0);
    expect(sessionStatusView(idle, claudes, Date.now()).state).toBe('working');
  });
});
