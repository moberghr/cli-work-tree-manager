import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

// Guards tests/setup/isolate-git.ts: tests (and what they spawn) must not
// see the developer's git config — commit signing there once froze a test
// worker for 10 minutes.
describe('test git isolation', () => {
  it('spawned git sees no global signing / hooks config, and has an identity', () => {
    const get = (key: string) => spawnSync('git', ['config', '--get', key], { encoding: 'utf-8' }).stdout.trim();
    expect(get('commit.gpgsign')).toBe('');
    expect(get('core.hooksPath')).toBe('');
    expect(process.env.GIT_CONFIG_GLOBAL).toMatch(/work-tests-empty\.gitconfig$/);
    expect(process.env.GIT_AUTHOR_NAME).toBeTruthy();
  });
});
