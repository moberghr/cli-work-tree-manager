import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  claudeProjectsRoot,
  effectiveLastAccessedAt,
  getClaudeActivityMs,
  readSessionActivity,
} from '../../src/core/claude-activity.js';
import type { WorktreeSession } from '../../src/core/history.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-act-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function projectDirFor(cwd: string): string {
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(tmpDir, '.claude', 'projects', slug);
}

function touch(dir: string, name: string, ageMs = 0): void {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, '{}\n');
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(f, t, t);
  }
}

function fakeSession(
  paths: string[],
  isGroup = false,
): WorktreeSession {
  return {
    target: 'repo',
    isGroup,
    branch: 'feat/x',
    paths,
    createdAt: '2026-01-01T00:00:00Z',
    lastAccessedAt: '2026-01-01T00:00:00Z',
  };
}

describe('claudeProjectsRoot', () => {
  it('points to ~/.claude/projects under the mocked homedir', () => {
    expect(claudeProjectsRoot()).toBe(
      path.join(tmpDir, '.claude', 'projects'),
    );
  });
});

describe('getClaudeActivityMs', () => {
  it('returns 0 when no project dir exists', () => {
    expect(getClaudeActivityMs('C:/no/such/path')).toBe(0);
  });

  it('returns the mtime of the most-recent .jsonl', () => {
    const dir = projectDirFor('C:/work/repo');
    touch(dir, 'old.jsonl', 60_000);
    touch(dir, 'new.jsonl', 0);
    const ms = getClaudeActivityMs('C:/work/repo');
    // New is "now"; old is 60s ago — we want the new one.
    expect(Math.abs(ms - Date.now())).toBeLessThan(2_000);
  });

  it('ignores non-.jsonl files', () => {
    const dir = projectDirFor('C:/work/repo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'something.txt'), '');
    expect(getClaudeActivityMs('C:/work/repo')).toBe(0);
  });
});

describe('readSessionActivity', () => {
  it('returns stale when no transcript exists', () => {
    expect(readSessionActivity(fakeSession(['C:/none']))).toEqual({
      lastActivity: null,
      state: 'stale',
    });
  });

  it('returns active for a transcript touched within 30s', () => {
    const cwd = 'C:/work/repo';
    touch(projectDirFor(cwd), 'a.jsonl', 5_000);
    const out = readSessionActivity(fakeSession([cwd]));
    expect(out.state).toBe('active');
    expect(out.lastActivity).toBeGreaterThan(0);
  });

  it('returns open for a transcript between 30s and 5min', () => {
    const cwd = 'C:/work/repo';
    touch(projectDirFor(cwd), 'a.jsonl', 60_000);
    expect(readSessionActivity(fakeSession([cwd])).state).toBe('open');
  });

  it('returns stale for a transcript older than 5min', () => {
    const cwd = 'C:/work/repo';
    touch(projectDirFor(cwd), 'a.jsonl', 10 * 60_000);
    expect(readSessionActivity(fakeSession([cwd])).state).toBe('stale');
  });

  it('for group sessions, uses the parent of the sub-repo paths', () => {
    const groupRoot = 'C:/work/group';
    touch(projectDirFor(groupRoot), 'a.jsonl', 5_000);
    // Group sessions have paths pointing at sub-repos; Claude launches in
    // the parent (group root).
    const session = fakeSession(
      ['C:/work/group/api', 'C:/work/group/web'],
      true,
    );
    expect(readSessionActivity(session).state).toBe('active');
  });

  it('picks the most recent across multiple launch paths', () => {
    const groupRoot = 'C:/work/group';
    touch(projectDirFor(groupRoot), 'old.jsonl', 60_000);
    const session = fakeSession(
      ['C:/work/group/api', 'C:/work/group/web'],
      true,
    );
    expect(readSessionActivity(session).state).toBe('open');
  });
});

describe('effectiveLastAccessedAt', () => {
  it('returns the later of session.lastAccessedAt and the transcript mtime', () => {
    const cwd = 'C:/work/repo';
    touch(projectDirFor(cwd), 'a.jsonl', 5_000);
    const session = fakeSession([cwd]);
    session.lastAccessedAt = '2020-01-01T00:00:00Z'; // ancient
    const ms = new Date(effectiveLastAccessedAt(session)).getTime();
    // Should be the transcript mtime, much later than 2020.
    expect(ms).toBeGreaterThan(new Date('2025-01-01T00:00:00Z').getTime());
  });

  it('keeps session.lastAccessedAt when it is newer than the transcript', () => {
    const cwd = 'C:/work/repo';
    touch(projectDirFor(cwd), 'a.jsonl', 60_000);
    const session = fakeSession([cwd]);
    // Force lastAccessedAt to "now" (newer than the 60s-old transcript).
    session.lastAccessedAt = new Date().toISOString();
    const ms = new Date(effectiveLastAccessedAt(session)).getTime();
    expect(Math.abs(ms - Date.now())).toBeLessThan(2_000);
  });
});
