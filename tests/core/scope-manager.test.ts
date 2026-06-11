import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Force loadConfig() to a known fixture by pointing HOME at a tmp dir
// BEFORE the scope-manager module is imported (it pulls config.ts which
// resolves ~/.work/config.json at call time, not module load time, so the
// env override works).
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'work-scope-test-'));
  fs.mkdirSync(path.join(tmpHome, '.work'), { recursive: true });
  // Test config with one repo and a worktreesRoot.
  fs.writeFileSync(
    path.join(tmpHome, '.work', 'config.json'),
    JSON.stringify({
      worktreesRoot: path.join(tmpHome, 'worktrees'),
      repos: {
        myrepo: path.join(tmpHome, 'repos', 'myrepo'),
      },
      groups: {},
      copyFiles: [],
    }),
    'utf-8',
  );
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

/** Poll `cond()` every 25ms up to `ms`. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe('registerScope path allowlist (S-2)', () => {
  it('accepts paths inside a configured repo', async () => {
    const { registerScope, disposeAllScopes } = await import(
      '../../src/core/scope-manager.js'
    );
    const repoPath = path.join(tmpHome, 'repos', 'myrepo');
    fs.mkdirSync(repoPath, { recursive: true });

    const scope = registerScope([repoPath], 'test');
    expect(scope.paths).toContain(path.resolve(repoPath));
    expect(scope.hash).toMatch(/^[a-f0-9]{12}$/);
    disposeAllScopes();
  });

  it('accepts paths inside worktreesRoot', async () => {
    const { registerScope, disposeAllScopes } = await import(
      '../../src/core/scope-manager.js'
    );
    const wt = path.join(tmpHome, 'worktrees', 'myrepo', 'feat-x');
    fs.mkdirSync(wt, { recursive: true });

    const scope = registerScope([wt], 'test');
    expect(scope.paths[0]).toBe(path.resolve(wt));
    disposeAllScopes();
  });

  it('rejects paths outside the configured repos/worktreesRoot', async () => {
    const { registerScope, ScopePathRejectedError, disposeAllScopes } =
      await import('../../src/core/scope-manager.js');
    const bad =
      process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';

    expect(() => registerScope([bad], 'bad')).toThrow(ScopePathRejectedError);
    disposeAllScopes();
  });

  it('rejects when one of several paths is outside (group worktree case)', async () => {
    const { registerScope, ScopePathRejectedError, disposeAllScopes } =
      await import('../../src/core/scope-manager.js');
    const ok = path.join(tmpHome, 'repos', 'myrepo');
    fs.mkdirSync(ok, { recursive: true });
    const bad =
      process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';

    try {
      registerScope([ok, bad], 'mixed');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ScopePathRejectedError);
      expect((err as InstanceType<typeof ScopePathRejectedError>).rejected)
        .toContain(path.resolve(bad));
    }
    disposeAllScopes();
  });

  it('is idempotent — same paths twice return the same scope', async () => {
    const { registerScope, disposeAllScopes } = await import(
      '../../src/core/scope-manager.js'
    );
    const repoPath = path.join(tmpHome, 'repos', 'myrepo');
    fs.mkdirSync(repoPath, { recursive: true });

    const a = registerScope([repoPath], 'one');
    const b = registerScope([repoPath], 'two');

    expect(a.hash).toBe(b.hash);
    // label can be updated on re-register
    expect(b.label).toBe('two');
    disposeAllScopes();
  });
});

describe('suppressScopeWatch — reload-loop guard', () => {
  it('drops fs-watch events inside the window, fires again after it clears', async () => {
    const { registerScope, subscribeScope, suppressScopeWatch, disposeAllScopes } =
      await import('../../src/core/scope-manager.js');
    const repoPath = path.join(tmpHome, 'repos', 'myrepo');
    fs.mkdirSync(repoPath, { recursive: true });
    const scope = registerScope([repoPath], 'sup');

    let hits = 0;
    const unsub = subscribeScope(scope.hash, () => {
      hits += 1;
    });
    try {
      // Let the OS watch arm.
      await new Promise((r) => setTimeout(r, 150));

      // Suppress (as the diff server does after computing a diff): a change
      // now must NOT fire — this is exactly the `.git`-churn-during-diff case
      // that used to loop the live-reload.
      suppressScopeWatch(scope.hash, 5000);
      fs.writeFileSync(path.join(repoPath, 'a.txt'), '1');
      await new Promise((r) => setTimeout(r, 600)); // > 150ms debounce
      expect(hits).toBe(0);

      // Clear the window; a real edit must reload again (live-reload intact).
      suppressScopeWatch(scope.hash, 0);
      fs.writeFileSync(path.join(repoPath, 'b.txt'), '2');
      expect(await waitFor(() => hits > 0)).toBe(true);
    } finally {
      unsub?.();
      disposeAllScopes();
    }
  });
});

describe('reviveScope', () => {
  it('clears the ended flag so a re-registered scope is a fresh review', async () => {
    const { registerScope, markScopeEnded, reviveScope, getScope, disposeAllScopes } =
      await import('../../src/core/scope-manager.js');
    const repoPath = path.join(tmpHome, 'repos', 'myrepo');
    fs.mkdirSync(repoPath, { recursive: true });
    try {
      const scope = registerScope([repoPath], 'revive');
      expect(markScopeEnded(scope.hash)).toBe(true);
      expect(getScope(scope.hash)?.ended).toBe(true);

      expect(reviveScope(scope.hash)).toBe(true);
      expect(getScope(scope.hash)?.ended).toBe(false);

      // Idempotent: an already-live scope reports false
      expect(reviveScope(scope.hash)).toBe(false);
      // Unknown hash reports false
      expect(reviveScope('nope')).toBe(false);
    } finally {
      disposeAllScopes();
    }
  });
});
