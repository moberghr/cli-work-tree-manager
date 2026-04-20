import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadHistory,
  saveHistory,
  upsertSession,
  removeSession,
  findSession,
  getSessionsForTarget,
  getRecentSessions,
  pruneStaleEntries,
  type WorktreeSession,
} from '../../src/core/history.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-history-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadHistory', () => {
  it('returns empty array when no history file exists', () => {
    expect(loadHistory()).toEqual([]);
  });

  it('loads valid history', () => {
    const historyDir = path.join(tmpDir, '.work');
    fs.mkdirSync(historyDir, { recursive: true });

    const sessions: WorktreeSession[] = [
      {
        target: 'api',
        isGroup: false,
        branch: 'feature/test',
        paths: ['/tmp/wt/api/feature-test'],
        createdAt: '2025-01-01T00:00:00.000Z',
        lastAccessedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    fs.writeFileSync(
      path.join(historyDir, 'history.json'),
      JSON.stringify(sessions),
    );

    expect(loadHistory()).toEqual(sessions);
  });

  it('returns empty array for invalid JSON', () => {
    const historyDir = path.join(tmpDir, '.work');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'history.json'), '{bad}');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadHistory()).toEqual([]);
  });

  it('backs up a corrupt history file instead of silently overwriting', () => {
    const historyDir = path.join(tmpDir, '.work');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'history.json'), '{bad}');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadHistory()).toEqual([]);

    const backups = fs
      .readdirSync(historyDir)
      .filter((f) => f.startsWith('history.json.bad-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(historyDir, backups[0]), 'utf-8')).toBe(
      '{bad}',
    );
  });

  it('returns empty array for non-array JSON', () => {
    const historyDir = path.join(tmpDir, '.work');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      path.join(historyDir, 'history.json'),
      JSON.stringify({ not: 'an array' }),
    );

    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadHistory()).toEqual([]);
  });
});

describe('saveHistory', () => {
  it('writes history as formatted JSON', () => {
    const sessions: WorktreeSession[] = [
      {
        target: 'api',
        isGroup: false,
        branch: 'main',
        paths: ['/tmp/wt'],
        createdAt: '2025-01-01T00:00:00.000Z',
        lastAccessedAt: '2025-01-01T00:00:00.000Z',
      },
    ];

    saveHistory(sessions);

    const historyPath = path.join(tmpDir, '.work', 'history.json');
    expect(fs.existsSync(historyPath)).toBe(true);

    const raw = fs.readFileSync(historyPath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(sessions);
    expect(raw).toContain('\n');
  });
});

describe('findSession', () => {
  it('finds a matching session', () => {
    const sessions: WorktreeSession[] = [
      {
        target: 'api',
        isGroup: false,
        branch: 'feat',
        paths: [],
        createdAt: '',
        lastAccessedAt: '',
      },
      {
        target: 'web',
        isGroup: false,
        branch: 'feat',
        paths: [],
        createdAt: '',
        lastAccessedAt: '',
      },
    ];

    expect(findSession(sessions, 'web', 'feat')?.target).toBe('web');
  });

  it('returns undefined when not found', () => {
    expect(findSession([], 'api', 'feat')).toBeUndefined();
  });
});

describe('upsertSession', () => {
  it('creates a new session', async () => {
    await upsertSession('api', false, 'feature/test', ['/tmp/wt']);

    const sessions = loadHistory();
    expect(sessions.length).toBe(1);
    expect(sessions[0].target).toBe('api');
    expect(sessions[0].branch).toBe('feature/test');
    expect(sessions[0].paths).toEqual(['/tmp/wt']);
    expect(sessions[0].createdAt).toBeTruthy();
  });

  it('updates lastAccessedAt on re-entry', async () => {
    await upsertSession('api', false, 'feat', ['/tmp/wt']);

    // Small delay to ensure different timestamp
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValueOnce(
      '2099-01-01T00:00:00.000Z',
    );
    await upsertSession('api', false, 'feat', ['/tmp/wt2']);

    const sessions = loadHistory();
    expect(sessions.length).toBe(1);
    expect(sessions[0].lastAccessedAt).toBe('2099-01-01T00:00:00.000Z');
    expect(sessions[0].paths).toEqual(['/tmp/wt2']);
  });

  it('keeps separate entries for different branches', async () => {
    await upsertSession('api', false, 'feat-a', ['/a']);
    await upsertSession('api', false, 'feat-b', ['/b']);

    expect(loadHistory().length).toBe(2);
  });

  it('serializes concurrent upserts without losing entries', async () => {
    // This is the regression test for the bug that wiped 60+ sessions:
    // two parallel upsertSession calls must not clobber each other's writes.
    await Promise.all([
      upsertSession('api', false, 'feat-a', ['/a']),
      upsertSession('api', false, 'feat-b', ['/b']),
      upsertSession('api', false, 'feat-c', ['/c']),
    ]);

    const sessions = loadHistory();
    expect(sessions.length).toBe(3);
    const branches = sessions.map((s) => s.branch).sort();
    expect(branches).toEqual(['feat-a', 'feat-b', 'feat-c']);
  });
});

describe('removeSession', () => {
  it('removes a matching session', async () => {
    await upsertSession('api', false, 'feat', ['/tmp']);
    await upsertSession('web', false, 'feat', ['/tmp2']);

    await removeSession('api', 'feat');

    const sessions = loadHistory();
    expect(sessions.length).toBe(1);
    expect(sessions[0].target).toBe('web');
  });

  it('does nothing when no match', async () => {
    await upsertSession('api', false, 'feat', ['/tmp']);
    await removeSession('web', 'feat');

    expect(loadHistory().length).toBe(1);
  });
});

describe('getSessionsForTarget', () => {
  it('filters by target', () => {
    const sessions: WorktreeSession[] = [
      {
        target: 'api',
        isGroup: false,
        branch: 'a',
        paths: [],
        createdAt: '',
        lastAccessedAt: '',
      },
      {
        target: 'web',
        isGroup: false,
        branch: 'b',
        paths: [],
        createdAt: '',
        lastAccessedAt: '',
      },
      {
        target: 'api',
        isGroup: false,
        branch: 'c',
        paths: [],
        createdAt: '',
        lastAccessedAt: '',
      },
    ];

    const result = getSessionsForTarget(sessions, 'api');
    expect(result.length).toBe(2);
    expect(result.every((s) => s.target === 'api')).toBe(true);
  });
});

describe('getRecentSessions', () => {
  it('returns most recent sessions sorted by lastAccessedAt', () => {
    const sessions: WorktreeSession[] = [
      {
        target: 'a',
        isGroup: false,
        branch: 'x',
        paths: [],
        createdAt: '',
        lastAccessedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        target: 'b',
        isGroup: false,
        branch: 'y',
        paths: [],
        createdAt: '',
        lastAccessedAt: '2025-03-01T00:00:00.000Z',
      },
      {
        target: 'c',
        isGroup: false,
        branch: 'z',
        paths: [],
        createdAt: '',
        lastAccessedAt: '2025-02-01T00:00:00.000Z',
      },
    ];

    const result = getRecentSessions(sessions, 2);
    expect(result.length).toBe(2);
    expect(result[0].target).toBe('b');
    expect(result[1].target).toBe('c');
  });

  it('returns all when count exceeds sessions', () => {
    const sessions: WorktreeSession[] = [
      {
        target: 'a',
        isGroup: false,
        branch: 'x',
        paths: [],
        createdAt: '',
        lastAccessedAt: '2025-01-01T00:00:00.000Z',
      },
    ];

    expect(getRecentSessions(sessions, 10).length).toBe(1);
  });
});

describe('pruneStaleEntries', () => {
  it('removes entries with non-existent paths', () => {
    const sessions: WorktreeSession[] = [
      {
        target: 'api',
        isGroup: false,
        branch: 'feat',
        paths: ['/nonexistent/path'],
        createdAt: '',
        lastAccessedAt: '',
      },
      {
        target: 'web',
        isGroup: false,
        branch: 'feat',
        paths: [tmpDir],
        createdAt: '',
        lastAccessedAt: '',
      },
    ];

    const { kept, pruned } = pruneStaleEntries(sessions);
    expect(pruned).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].target).toBe('web');
  });

  it('keeps entries where at least one path exists', () => {
    const sessions: WorktreeSession[] = [
      {
        target: 'api',
        isGroup: true,
        branch: 'feat',
        paths: ['/nonexistent', tmpDir],
        createdAt: '',
        lastAccessedAt: '',
      },
    ];

    const { kept, pruned } = pruneStaleEntries(sessions);
    expect(pruned).toBe(0);
    expect(kept.length).toBe(1);
  });

  it('returns zero pruned when all valid', () => {
    const { kept, pruned } = pruneStaleEntries([]);
    expect(pruned).toBe(0);
    expect(kept).toEqual([]);
  });
});
