import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atLeast,
  binaryStamp,
  claudeReadOnlyAvailable,
  forgetClaudeVersions,
  parseClaudeVersion,
  runVersion,
  VERSION_TTL_MS,
  type VersionIo,
} from '../../../../src/core/agents/claude/version.js';
import { READ_ONLY_MIN_VERSION } from '../../../../src/core/agents/claude/internal.js';
import { claudeAgent } from '../../../../src/core/agents/claude/adapter.js';

/** The read-only review run's flags were measured on one Claude Code: an older one (or an unknown one) gets none. */

afterEach(() => forgetClaudeVersions());

const io = (over: Partial<VersionIo> = {}) => ({
  find: () => '/bin/claude',
  stamp: (): string | null => '/bin/claude|1000|10',
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

  it('asked once per binary: the same stamp answers from memory; an update (new stamp) or another path asks again', async () => {
    let stamp = 'a|1000|10';
    const x = io({ stamp: () => stamp });
    await claudeReadOnlyAvailable(x);
    await claudeReadOnlyAvailable(x);
    expect(x.version).toHaveBeenCalledTimes(1);
    stamp = 'a|1000|11';
    await claudeReadOnlyAvailable(x);
    expect(x.version).toHaveBeenCalledTimes(2);
    const other = io({ find: () => '/other/claude' });
    await claudeReadOnlyAvailable(other);
    expect(other.version).toHaveBeenCalledTimes(1);
  });

  it('an answer is kept at most VERSION_TTL_MS; a binary that cannot be identified is never remembered', async () => {
    let t = 0;
    const x = io({ now: () => t });
    await claudeReadOnlyAvailable(x);
    t = VERSION_TTL_MS - 1;
    await claudeReadOnlyAvailable(x);
    expect(x.version).toHaveBeenCalledTimes(1);
    t = VERSION_TTL_MS + 1;
    await claudeReadOnlyAvailable(x);
    expect(x.version).toHaveBeenCalledTimes(2);
    const unknown = io({ stamp: () => null });
    await claudeReadOnlyAvailable(unknown);
    await claudeReadOnlyAvailable(unknown);
    expect(unknown.version).toHaveBeenCalledTimes(2);
  });

  it('binaryStamp sees an npm update though npm dates every file 1985: the real file, its install time and size', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stamp-'));
    try {
      const file = path.join(dir, 'cli.js');
      const npm1985 = new Date('1985-10-26T08:15:00Z');
      fs.writeFileSync(file, '// 2.1.300');
      fs.utimesSync(file, npm1985, npm1985);
      const before = binaryStamp(file);
      expect(before).toContain(fs.realpathSync(file));
      expect(binaryStamp(file)).toBe(before); // nothing changed: the same
      // npm unpacks the new version over it, dated 1985 again.
      fs.writeFileSync(file, '// 2.1.317, a longer file');
      fs.utimesSync(file, npm1985, npm1985);
      expect(binaryStamp(file)).not.toBe(before);
      expect(binaryStamp(path.join(dir, 'gone'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("the adapter's read-only mode asks it", () => {
    expect(typeof claudeAgent.oneShot?.readOnly?.available).toBe('function');
  });

  it.runIf(process.platform === 'win32')('a real binary: --version is run (with a timeout), its answer read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-version-'));
    try {
      const file = path.join(dir, 'claude.cmd');
      fs.writeFileSync(file, '@echo 2.1.400 (Claude Code)\r\n');
      expect(await claudeReadOnlyAvailable({ find: () => file, stamp: binaryStamp, version: runVersion })).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
