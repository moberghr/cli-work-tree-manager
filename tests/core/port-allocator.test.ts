import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { allocatePort, DEFAULT_PORT_RANGE } from '../../src/core/port-allocator.js';
import type { WorktreeSession } from '../../src/core/history.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-port-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function session(over: Partial<WorktreeSession>): WorktreeSession {
  return {
    target: 'api',
    isGroup: false,
    branch: 'feat',
    paths: [tmpDir], // exists by default => active
    createdAt: '',
    lastAccessedAt: '',
    ...over,
  };
}

describe('allocatePort', () => {
  it('is deterministic: same name => same port', () => {
    const a = allocatePort('feature-login', {}, []);
    const b = allocatePort('feature-login', {}, []);
    expect(a).toBe(b);
  });

  it('allocates within the default 3000-3099 range when unconfigured', () => {
    const p = allocatePort('anything', {}, []);
    expect(p).toBeGreaterThanOrEqual(DEFAULT_PORT_RANGE.start);
    expect(p).toBeLessThanOrEqual(DEFAULT_PORT_RANGE.end);
  });

  it('respects a custom range', () => {
    const p = allocatePort('whatever', { portRange: { start: 4000, end: 4009 } }, []);
    expect(p).toBeGreaterThanOrEqual(4000);
    expect(p).toBeLessThanOrEqual(4009);
  });

  it('avoids ports held by active sessions', () => {
    const base = allocatePort('worktree-x', {}, []);
    const sessions = [session({ port: base })];
    const next = allocatePort('worktree-x', {}, sessions);
    expect(next).not.toBe(base);
    expect(next).toBeGreaterThanOrEqual(DEFAULT_PORT_RANGE.start);
    expect(next).toBeLessThanOrEqual(DEFAULT_PORT_RANGE.end);
  });

  it('ignores ports from inactive sessions (no existing path)', () => {
    const base = allocatePort('worktree-y', {}, []);
    const sessions = [session({ port: base, paths: ['/definitely/not/here'] })];
    const got = allocatePort('worktree-y', {}, sessions);
    // Inactive session's port is free, so we get the deterministic base again.
    expect(got).toBe(base);
  });

  it('wraps around the range to find a free port', () => {
    // Tiny range; occupy the base offset and force a wrap.
    const range = { start: 5000, end: 5002 };
    const base = allocatePort('wrapper', { portRange: range }, []);
    const sessions = [session({ port: base })];
    const got = allocatePort('wrapper', { portRange: range }, sessions);
    expect(got).not.toBe(base);
    expect([5000, 5001, 5002]).toContain(got);
  });

  it('throws when every port in the range is occupied', () => {
    const range = { start: 6000, end: 6001 };
    const sessions = [
      session({ port: 6000 }),
      session({ port: 6001, branch: 'feat2' }),
    ];
    expect(() => allocatePort('full', { portRange: range }, sessions)).toThrow(/No free/);
  });

  it('normalizes a reversed range', () => {
    const p = allocatePort('rev', { portRange: { start: 7010, end: 7000 } }, []);
    expect(p).toBeGreaterThanOrEqual(7000);
    expect(p).toBeLessThanOrEqual(7010);
  });
});
