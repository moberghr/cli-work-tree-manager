import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atLeast,
  claudeReadOnlyAvailable,
  forgetClaudeVersions,
  parseClaudeVersion,
  runVersion,
  type VersionIo,
} from '../../../../src/core/agents/claude/version.js';
import { READ_ONLY_MIN_VERSION } from '../../../../src/core/agents/claude/internal.js';
import { claudeAgent } from '../../../../src/core/agents/claude/adapter.js';

/** The read-only review run's flags were measured on one Claude Code: an older one (or an unknown one) gets none. */

afterEach(() => forgetClaudeVersions());

const io = (over: Partial<VersionIo> = {}) => ({
  find: () => '/bin/claude',
  mtime: () => 1000,
  version: vi.fn(async () => '2.1.317 (Claude Code)\n'),
  ...over,
});

describe("Claude Code's version for the read-only review run", () => {
  it('parses and compares part by part', () => {
    expect(parseClaudeVersion('2.1.317 (Claude Code)')).toEqual([2, 1, 317]);
    expect(parseClaudeVersion('Claude Code')).toBeNull();
    expect(atLeast([2, 1, 317], [2, 1, 317])).toBe(true);
    expect(atLeast([2, 2, 0], [2, 1, 317])).toBe(true);
    expect(atLeast([2, 1, 99], [2, 1, 317])).toBe(false);
    expect(atLeast([1, 9, 999], [2, 1, 317])).toBe(false);
    expect(READ_ONLY_MIN_VERSION).toBe('2.1.317');
  });

  it('the measured version and newer: ok; older: not, saying which', async () => {
    expect(await claudeReadOnlyAvailable(io())).toEqual({ ok: true });
    forgetClaudeVersions();
    expect(await claudeReadOnlyAvailable(io({ version: vi.fn(async () => '2.3.0 (Claude Code)') }))).toEqual({ ok: true });
    forgetClaudeVersions();
    expect(await claudeReadOnlyAvailable(io({ version: vi.fn(async () => '2.1.200 (Claude Code)') }))).toEqual({
      ok: false,
      why: 'Claude Code 2.1.200 is older than 2.1.317, the version its read-only flags were measured on',
    });
  });

  it("unknown is no: not on PATH, --version failing or saying nothing — and that isn't remembered", async () => {
    expect(await claudeReadOnlyAvailable(io({ find: () => null }))).toMatchObject({ ok: false, why: expect.stringContaining('PATH') });
    const version = vi.fn(async (_file: string): Promise<string | null> => null);
    const failing = io({ version });
    expect(await claudeReadOnlyAvailable(failing)).toMatchObject({ ok: false, why: expect.stringContaining("can't be told") });
    expect(await claudeReadOnlyAvailable(io({ version: vi.fn(async () => 'oops') }))).toMatchObject({ ok: false });
    await claudeReadOnlyAvailable(failing);
    expect(version).toHaveBeenCalledTimes(2); // asked again
  });

  it('asked once per binary: the same path and time answer from memory; an update (new time) or another path asks again', async () => {
    let mtime = 1000;
    const x = io({ mtime: () => mtime });
    await claudeReadOnlyAvailable(x);
    await claudeReadOnlyAvailable(x);
    expect(x.version).toHaveBeenCalledTimes(1);
    mtime = 2000;
    await claudeReadOnlyAvailable(x);
    expect(x.version).toHaveBeenCalledTimes(2);
    const other = io({ find: () => '/other/claude' });
    await claudeReadOnlyAvailable(other);
    expect(other.version).toHaveBeenCalledTimes(1);
  });

  it("the adapter's read-only mode asks it", () => {
    expect(typeof claudeAgent.oneShot?.readOnly?.available).toBe('function');
  });

  it.runIf(process.platform === 'win32')('a real binary: --version is run (with a timeout), its answer read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-version-'));
    try {
      const file = path.join(dir, 'claude.cmd');
      fs.writeFileSync(file, '@echo 2.1.400 (Claude Code)\r\n');
      expect(await claudeReadOnlyAvailable({ find: () => file, mtime: () => 1, version: runVersion })).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
