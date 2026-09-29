import { describe, it, expect, afterEach } from 'vitest';
import {
  INTERNAL_CLAUDE_ENV,
  internalClaudeEnv,
  isInternalClaude,
} from '../../src/core/internal-claude.js';

const original = process.env[INTERNAL_CLAUDE_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[INTERNAL_CLAUDE_ENV];
  else process.env[INTERNAL_CLAUDE_ENV] = original;
});

describe('internal-claude marker', () => {
  it('internalClaudeEnv() sets the marker to "1"', () => {
    expect(internalClaudeEnv()).toEqual({ [INTERNAL_CLAUDE_ENV]: '1' });
  });

  it('isInternalClaude() reflects the env var', () => {
    delete process.env[INTERNAL_CLAUDE_ENV];
    expect(isInternalClaude()).toBe(false);
    process.env[INTERNAL_CLAUDE_ENV] = '1';
    expect(isInternalClaude()).toBe(true);
  });

  it('a child spawned with the overlay would carry the marker forward', () => {
    // Mirrors how the hook subprocess inherits the marker: the overlay is
    // merged onto process.env, so any descendant sees WORK_INTERNAL_CLAUDE.
    const childEnv = { ...process.env, ...internalClaudeEnv() };
    expect(childEnv[INTERNAL_CLAUDE_ENV]).toBe('1');
  });
});

describe('internalClaudeSpawn', () => {
  it('runs text-only: no tools, a neutral cwd, tagged as internal', async () => {
    const os = await import('node:os');
    const { internalClaudeSpawn, INTERNAL_CLAUDE_ENV } = await import('../../src/core/internal-claude.js');
    const run = internalClaudeSpawn();
    // `--tools ""` disables every tool: text in the prompt (a diff, another
    // repo's CLAUDE.md) can't make this run execute anything.
    expect(run.args).toEqual(['-p', '--tools', '']);
    expect(run.cwd).toBe(os.tmpdir()); // no project's .claude/settings.json applies
    expect(run.env[INTERNAL_CLAUDE_ENV]).toBe('1');
  });
});
