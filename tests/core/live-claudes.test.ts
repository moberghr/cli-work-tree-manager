import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';

vi.mock('../../src/core/process.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/process.js')>()),
  processTable: vi.fn(() => new Map<number, string>()),
  bootTime: vi.fn(() => 1_000_000),
}));
import { processTable } from '../../src/core/process.js';
import { aliveOnly, claudesBySession, parseLiveClaude, readLiveClaudes, summarizeClaudes, type LiveClaude } from '../../src/core/live-claudes.js';

const session = (branch: string, dir: string): WorktreeSession => ({
  target: 'app', branch, isGroup: false, paths: [dir], createdAt: '2026-09-01T00:00:00Z', lastAccessedAt: '2026-09-01T00:00:00Z',
} as WorktreeSession);
const claude = (pid: number, over: Partial<LiveClaude> = {}): LiveClaude => ({ pid, conversationId: `c${pid}`, cwd: '/wt/a', busy: false, startedAt: 2_000_000, ...over });

describe('parseLiveClaude', () => {
  it("reads Claude Code's per-process file", () => {
    expect(parseLiveClaude({ pid: 468, sessionId: 'abc', cwd: 'C:\\repo', status: 'busy', startedAt: 5, statusUpdatedAt: 9, kind: 'interactive' }))
      .toEqual({ pid: 468, conversationId: 'abc', cwd: 'C:\\repo', busy: true, state: 'busy', stateAt: 9, waitingFor: null, startedAt: 5 });
    expect(parseLiveClaude({ pid: 1, sessionId: 'a', cwd: '/x', status: 'waiting', waitingFor: 'dialog open' })).toMatchObject({ state: 'waiting', waitingFor: 'dialog open', busy: false });
    expect(parseLiveClaude({ pid: 1, sessionId: 'a', cwd: '/x', status: 'sleeping' })?.state).toBeNull(); // not a state we know
  });
  it('skips anything without the fields it needs (the format is not ours)', () => {
    expect(parseLiveClaude({ pid: '468', sessionId: 'abc', cwd: '/x' })).toBeNull();
    expect(parseLiveClaude({ pid: 1, cwd: '/x' })).toBeNull();
    expect(parseLiveClaude(null)).toBeNull();
  });
});

describe('aliveOnly', () => {
  it('believes a pid only if a Claude runs under it and it started since boot', () => {
    const table = new Map([[1, 'claude.exe'], [2, 'chrome.exe'], [3, 'node']]);
    const list = [claude(1), claude(2), claude(3), claude(4), claude(1, { conversationId: 'old', startedAt: 10 })];
    expect(aliveOnly(list, table, 1_000_000).map((c) => c.conversationId)).toEqual(['c1', 'c3']);
  });
});

describe('summarizeClaudes', () => {
  it("counts where they run and flags two on one conversation", () => {
    expect(summarizeClaudes([], new Set())).toBeNull();
    expect(summarizeClaudes([claude(1, { busy: true })], new Set())).toEqual({ inTerminal: 1, inApp: 0, busy: true, duplicate: false });
    expect(summarizeClaudes([claude(1, { conversationId: 'x' }), claude(2, { conversationId: 'x' })], new Set([2])))
      .toEqual({ inTerminal: 1, inApp: 1, busy: false, duplicate: true });
  });

  it("carries the most telling state: any mid-turn, else any waiting on you, else idle", () => {
    const at = (state: LiveClaude['state'], stateAt: number, waitingFor: string | null = null) => ({ state, stateAt, waitingFor });
    expect(summarizeClaudes([claude(1, at('idle', 5)), claude(2, at('waiting', 7, 'dialog open'))], new Set())).toMatchObject({ state: 'waiting', stateAt: 7, waitingFor: 'dialog open' });
    expect(summarizeClaudes([claude(1, at('waiting', 7)), claude(2, { ...at('busy', 3), busy: true })], new Set())).toMatchObject({ state: 'busy', stateAt: 3 });
    expect(summarizeClaudes([claude(1)], new Set())).not.toHaveProperty('state'); // an old Claude Code: none
  });
});

describe('claudesBySession', () => {
  it('maps each Claude to the session whose folder it runs in', () => {
    const a = session('feat/a', path.resolve('/wt/a'));
    const b = session('feat/b', path.resolve('/wt/b'));
    const map = claudesBySession([claude(1, { cwd: path.resolve('/wt/a') }), claude(2, { cwd: path.resolve('/wt/a/src') }), claude(3, { cwd: path.resolve('/elsewhere') })], [a, b]);
    expect(map.get(sessionIdFor(a))?.map((c) => c.pid)).toEqual([1, 2]);
    expect(map.has(sessionIdFor(b))).toBe(false);
  });
});

describe('readLiveClaudes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-claudes-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the folder, skipping broken files and dead pids', () => {
    fs.writeFileSync(path.join(dir, '11.json'), JSON.stringify({ pid: 11, sessionId: 's11', cwd: '/wt/a', status: 'idle', startedAt: 2_000_000 }));
    fs.writeFileSync(path.join(dir, '12.json'), JSON.stringify({ pid: 12, sessionId: 's12', cwd: '/wt/b', startedAt: 2_000_000 }));
    fs.writeFileSync(path.join(dir, '13.json'), '{ half written');
    fs.writeFileSync(path.join(dir, '11.abc.key'), 'not a session file');
    vi.mocked(processTable).mockReturnValue(new Map([[11, 'claude.exe']]));
    expect(readLiveClaudes(dir, 1).map((c) => c.pid)).toEqual([11]);
  });

  it('is empty when the folder does not exist', () => {
    expect(readLiveClaudes(path.join(dir, 'missing'), 99)).toEqual([]);
  });
});
