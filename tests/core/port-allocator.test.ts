import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {
  allocatePort,
  allocateFreePort,
  isPortFree,
  DEFAULT_PORT_RANGE,
  PortRangeExhaustedError,
} from '../../src/core/port-allocator.js';
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

  it('throws a distinct PortRangeExhaustedError when every port is occupied', () => {
    const range = { start: 6000, end: 6001 };
    const sessions = [
      session({ port: 6000 }),
      session({ port: 6001, branch: 'feat2' }),
    ];
    expect(() => allocatePort('full', { portRange: range }, sessions)).toThrow(
      PortRangeExhaustedError,
    );
    try {
      allocatePort('full', { portRange: range }, sessions);
    } catch (err) {
      expect(err).toBeInstanceOf(PortRangeExhaustedError);
      expect((err as PortRangeExhaustedError).start).toBe(6000);
      expect((err as PortRangeExhaustedError).end).toBe(6001);
    }
  });

  it('normalizes a reversed range', () => {
    const p = allocatePort('rev', { portRange: { start: 7010, end: 7000 } }, []);
    expect(p).toBeGreaterThanOrEqual(7000);
    expect(p).toBeLessThanOrEqual(7010);
  });

  it('hashes the full seed key, so two repos sharing a branch can differ', () => {
    // Seeding with `target:branch` (not just the branch) means repoA:feat and
    // repoB:feat have independent base offsets. Over a wide range they should
    // land on different deterministic ports rather than always colliding.
    const range = { start: 8000, end: 8099 };
    const a = allocatePort('repoA:feat', { portRange: range }, []);
    const b = allocatePort('repoB:feat', { portRange: range }, []);
    expect(a).not.toBe(b);
    // Same seed key is still stable.
    expect(allocatePort('repoA:feat', { portRange: range }, [])).toBe(a);
  });
});

describe('isPortFree', () => {
  it('returns false for a port that is actively bound', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns true for a port nobody is listening on', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Port is now released.
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('allocateFreePort', () => {
  it('skips ports the host probe reports as in use', async () => {
    const range = { start: 9000, end: 9009 };
    const base = allocatePort('hostprobe', { portRange: range }, []);
    // Probe claims the deterministic base is taken on the host; allocator must
    // walk past it even though our history is empty.
    const probe = vi.fn(async (p: number) => p !== base);
    const got = await allocateFreePort('hostprobe', { portRange: range }, [], probe);
    expect(got).not.toBe(base);
    expect(got).toBeGreaterThanOrEqual(9000);
    expect(got).toBeLessThanOrEqual(9009);
    expect(probe).toHaveBeenCalled();
  });

  it('returns the deterministic base when the host probe is all-clear', async () => {
    const range = { start: 9100, end: 9199 };
    const base = allocatePort('clear', { portRange: range }, []);
    const got = await allocateFreePort('clear', { portRange: range }, [], async () => true);
    expect(got).toBe(base);
  });

  it('throws PortRangeExhaustedError when both history and host fill the range', async () => {
    const range = { start: 9200, end: 9201 };
    const sessions = [session({ port: 9200 })];
    // History holds 9200; host probe claims 9201 is taken too.
    await expect(
      allocateFreePort('full', { portRange: range }, sessions, async () => false),
    ).rejects.toBeInstanceOf(PortRangeExhaustedError);
  });
});
