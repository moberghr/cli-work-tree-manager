import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { findSessionForCwd } from '../../../src/core/comments/pending-delivery.js';

const sessionForCwd = (sessions: WorktreeSession[], cwd: string) => findSessionForCwd(cwd, sessions);
import type { WorktreeSession } from '../../../src/core/sessions/history.js';

const root = path.resolve('/wt');
const s = (target: string, branch: string, paths: string[], isGroup = false) =>
  ({ target, branch, paths, isGroup }) as unknown as WorktreeSession;

describe('findSessionForCwd (used by attach and the Claude hooks)', () => {
  const single = s('api', 'feat/x', [path.join(root, 'api', 'feat-x')]);
  const group = s('shop', 'feat/y', [
    path.join(root, 'shop', 'feat-y', 'backend'),
    path.join(root, 'shop', 'feat-y', 'frontend'),
  ], true);

  it('matches a subdirectory of a single-repo worktree', () => {
    expect(sessionForCwd([single, group], path.join(root, 'api', 'feat-x', 'src'))).toBe(single);
  });

  it('matches a group from its root and from inside a sub-repo', () => {
    expect(sessionForCwd([single, group], path.join(root, 'shop', 'feat-y'))).toBe(group);
    expect(sessionForCwd([single, group], path.join(root, 'shop', 'feat-y', 'frontend', 'src'))).toBe(group);
  });

  it('does not match a sibling directory sharing a prefix', () => {
    expect(sessionForCwd([single], path.join(root, 'api', 'feat-x2'))).toBeNull();
  });
});

describe('findSessionForCwd — group root (where Claude runs for a group)', () => {
  it('maps the group root itself to the group session', () => {
    const root = path.resolve('/wt/shop/feat-y');
    const g = { target: 'shop', branch: 'feat/y', isGroup: true, paths: [path.join(root, 'api'), path.join(root, 'web')] } as unknown as WorktreeSession;
    expect(findSessionForCwd(root, [g])).toBe(g);
  });

  it('does not treat a single repo worktree\'s parent as a root', () => {
    const one = { target: 'api', branch: 'x', isGroup: false, paths: [path.resolve('/wt/api/x')] } as unknown as WorktreeSession;
    expect(findSessionForCwd(path.resolve('/wt/api'), [one])).toBeNull();
  });
});

describe('work attach <target> with no branch = the base checkout (reviewed bug)', () => {
  it('finds the base-repo session by path, whatever branch it was stored under', async () => {
    const { baseCheckoutSession } = await import('../../../src/commands/attach.js');
    const repo = path.resolve('/repos/api');
    const base = { target: 'api', branch: 'main', isGroup: false, paths: [repo], lastAccessedAt: '2026-01-02' } as unknown as WorktreeSession;
    const older = { ...base, branch: 'develop', lastAccessedAt: '2026-01-01' } as WorktreeSession;
    const feature = { target: 'api', branch: 'feat/x', isGroup: false, paths: [path.resolve('/wt/api/feat-x')], lastAccessedAt: '2026-01-03' } as unknown as WorktreeSession;
    const cfg = { repos: { api: repo } };
    expect(baseCheckoutSession([feature, older, base], 'api', cfg)).toBe(base);
    expect(baseCheckoutSession([feature], 'api', cfg)).toBeNull();
    expect(baseCheckoutSession([base], 'nope', cfg)).toBeNull();
  });
});
