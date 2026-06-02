import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { broadcastPrompt } from '../../src/core/broadcast.js';
import { sessionIdFor } from '../../src/core/web-state.js';
import { clearCommentStoreCache } from '../../src/core/comment-file-store.js';
import { readPendingForSession } from '../../src/core/pending-delivery.js';
import type { WorktreeSession } from '../../src/core/history.js';

let tmpDir: string;

function session(target: string, branch: string): WorktreeSession {
  return {
    target,
    branch,
    paths: [`/wt/${target}/${branch}`],
    isGroup: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
  };
}

const sessions: WorktreeSession[] = [
  session('api', 'feat/a'),
  session('api', 'feat/b'),
  session('web', 'feat/a'),
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-broadcast-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  clearCommentStoreCache();
});

afterEach(() => {
  clearCommentStoreCache();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('broadcastPrompt', () => {
  it('targets the correct sessionIds for a target filter', () => {
    const queued = broadcastPrompt(sessions, { target: 'api' }, 'hello');
    expect(queued.map((q) => q.sessionId).sort()).toEqual(
      [sessionIdFor(sessions[0]), sessionIdFor(sessions[1])].sort(),
    );
  });

  it('targets all sessions with an empty filter', () => {
    const queued = broadcastPrompt(sessions, {}, 'hello');
    expect(queued).toHaveLength(3);
  });

  it('creates a published user comment picked up by pending-delivery', () => {
    const target = sessions[0];
    broadcastPrompt(sessions, { target: 'api', branch: 'feat/a' }, 'do the thing');

    const sessionId = sessionIdFor(target);
    // It lands on disk as a comment file.
    const file = path.join(tmpDir, '.work', 'comments', `${sessionId}.json`);
    expect(fs.existsSync(file)).toBe(true);

    // And the pending-delivery reader surfaces it (published + user).
    clearCommentStoreCache();
    const pending = readPendingForSession(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe('do the thing');
    expect(pending[0].author).toBe('user');
    expect(pending[0].status).toBe('published');
    expect(pending[0].side).toBe('general');
  });

  it('throws on an empty prompt', () => {
    expect(() => broadcastPrompt(sessions, {}, '   ')).toThrow();
  });
});
