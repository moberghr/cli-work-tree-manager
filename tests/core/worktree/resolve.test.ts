import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  resolveProjectTarget,
  getAllTargetNames,
  matchTargetByWorktreePath,
  matchTargetByRepoRoot,
} from '../../../src/core/worktree/resolve.js';
import type { WorkConfig } from '../../../src/core/platform/config.js';

const config: WorkConfig = {
  worktreesRoot: '/tmp/worktrees',
  repos: {
    api: '/repos/api',
    frontend: '/repos/frontend',
    shared: '/repos/shared',
  },
  groups: {
    fullstack: ['api', 'frontend'],
    all: ['api', 'frontend', 'shared'],
  },
  copyFiles: [],
};

describe('resolveProjectTarget', () => {
  it('resolves a single repo', () => {
    const result = resolveProjectTarget('api', config);
    expect(result).toEqual({
      isGroup: false,
      name: 'api',
      repoAliases: ['api'],
    });
  });

  it('resolves a group', () => {
    const result = resolveProjectTarget('fullstack', config);
    expect(result).toEqual({
      isGroup: true,
      name: 'fullstack',
      repoAliases: ['api', 'frontend'],
    });
  });

  it('returns null for unknown name', () => {
    const result = resolveProjectTarget('nonexistent', config);
    expect(result).toBeNull();
  });

  it('prefers group over repo if names collide', () => {
    const collisionConfig: WorkConfig = {
      ...config,
      repos: { ...config.repos, fullstack: '/repos/fullstack' },
    };
    const result = resolveProjectTarget('fullstack', collisionConfig);
    expect(result?.isGroup).toBe(true);
  });

  it('returns a copy of repoAliases (not a reference)', () => {
    const result = resolveProjectTarget('fullstack', config);
    result!.repoAliases.push('extra');
    expect(config.groups.fullstack).toEqual(['api', 'frontend']);
  });
});

describe('getAllTargetNames', () => {
  it('returns all repo and group names', () => {
    const names = getAllTargetNames(config);
    expect(names).toEqual(['api', 'frontend', 'shared', 'fullstack', 'all']);
  });

  it('returns empty array when no repos or groups', () => {
    const empty: WorkConfig = {
      worktreesRoot: '',
      repos: {},
      groups: {},
      copyFiles: [],
    };
    expect(getAllTargetNames(empty)).toEqual([]);
  });
});

describe('matchTargetByWorktreePath', () => {
  it('matches a single-repo worktree path', () => {
    const result = matchTargetByWorktreePath(config, path.join('/tmp/worktrees', 'api', 'feature-login'));
    expect(result).toEqual({ target: 'api', isGroup: false });
  });

  it('matches a group worktree path (with sub-repo segment)', () => {
    const result = matchTargetByWorktreePath(config, path.join('/tmp/worktrees', 'fullstack', 'feature-login', 'api'));
    expect(result).toEqual({ target: 'fullstack', isGroup: true });
  });

  it('matches a group path with a trailing subdir', () => {
    const result = matchTargetByWorktreePath(config, path.join('/tmp/worktrees', 'all', 'feature-x', 'shared', 'src'));
    expect(result).toEqual({ target: 'all', isGroup: true });
  });

  it('returns null for a path not under worktreesRoot', () => {
    const result = matchTargetByWorktreePath(config, '/somewhere/else/api/feature-login');
    expect(result).toBeNull();
  });

  it('returns null when the worktree path equals the root itself', () => {
    const result = matchTargetByWorktreePath(config, '/tmp/worktrees');
    expect(result).toBeNull();
  });

  it('returns null for an unknown first segment', () => {
    const result = matchTargetByWorktreePath(config, path.join('/tmp/worktrees', 'unknown', 'feature-login'));
    expect(result).toBeNull();
  });

  it('matches by repo folder basename when alias differs from basename', () => {
    const aliasConfig: WorkConfig = {
      ...config,
      repos: { ...config.repos, api: '/repos/api-service' },
    };
    const result = matchTargetByWorktreePath(aliasConfig, path.join('/tmp/worktrees', 'api-service', 'feature-login'));
    expect(result).toEqual({ target: 'api', isGroup: false });
  });

  it('matches when the input is realpath-resolved but the config root is symlinked', () => {
    // git --show-toplevel returns the symlink-resolved path; the config root
    // may still contain the symlinked component (macOS /tmp -> /private/tmp).
    const realpath = (p: string) => p.replace(/^\/tmp\//, '/private/tmp/');
    const result = matchTargetByWorktreePath(config, '/private/tmp/worktrees/fullstack/feature-login/api', realpath);
    expect(result).toEqual({ target: 'fullstack', isGroup: true });
  });
});

describe('matchTargetByRepoRoot', () => {
  const identity = (p: string) => p;

  it('matches a repo root to its alias', () => {
    const result = matchTargetByRepoRoot(config, '/repos/api', identity);
    expect(result).toEqual({ target: 'api', isGroup: false });
  });

  it('returns null when no repo root matches', () => {
    const result = matchTargetByRepoRoot(config, '/repos/nope', identity);
    expect(result).toBeNull();
  });

  it('uses the injected realpath fn for canonicalization', () => {
    const canonical = (p: string) => (p === '/tmp/api' ? '/repos/api' : p);
    const result = matchTargetByRepoRoot(config, '/tmp/api', canonical);
    expect(result).toEqual({ target: 'api', isGroup: false });
  });
});

describe('resolveFromCwd in a folder session (work tree --here)', () => {
  it("a repo added to a session's folder resolves to that session, not to the repo found there", async () => {
    const fs = (await import('node:fs')).default;
    const os = (await import('node:os')).default;
    const { git } = await import('../../../src/core/git/git.js');
    const { resolveFromCwd, folderSessionAt } = await import('../../../src/core/worktree/resolve.js');
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-here-')));
    try {
      // Two repos whose folders aren't named as their aliases.
      const repos: Record<string, string> = {};
      for (const [alias, folder] of [
        ['api', 'api-repo'],
        ['web', 'web-repo'],
      ]) {
        const dir = path.join(tmp, 'src', folder);
        fs.mkdirSync(dir, { recursive: true });
        git(['init', '-q', '-b', 'main'], dir);
        fs.writeFileSync(path.join(dir, 'r.txt'), alias);
        git(['add', '.'], dir);
        git(['-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-q', '-m', 'init', '--no-gpg-sign'], dir);
        repos[alias] = dir;
      }
      const root = path.join(tmp, 'wt');
      const folder = path.join(root, 'api', 'feat-x');
      const paths = ['api-repo', 'web-repo'].map((f) => path.join(folder, f));
      git(['worktree', 'add', '-q', '-b', 'feat/x', paths[0]], repos.api);
      git(['worktree', 'add', '-q', '-b', 'feat/x', paths[1]], repos.web);
      const cfg: WorkConfig = { worktreesRoot: root, repos, groups: {}, copyFiles: [] };
      const session = { target: 'api', isGroup: true, branch: 'feat/x', paths, repos: ['api', 'web'], createdAt: '', lastAccessedAt: '' };

      expect(folderSessionAt([session], paths[1])).toBe(session);
      // Inside the added repo: the session's target, as a folder session.
      expect(resolveFromCwd(cfg, paths[1], [session])).toMatchObject({ target: 'api', isGroup: true, branch: 'feat/x' });
      // Without the sessions (as before): the path names no group, and the repo there is web.
      expect(resolveFromCwd(cfg, paths[1])).toMatchObject({ target: 'web', isGroup: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
});
