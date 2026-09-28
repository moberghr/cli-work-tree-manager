import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { sessionForCwd } from '../../src/commands/attach.js';
import type { WorktreeSession } from '../../src/core/history.js';

const root = path.resolve('/wt');
const s = (target: string, branch: string, paths: string[], isGroup = false) =>
  ({ target, branch, paths, isGroup }) as unknown as WorktreeSession;

describe('sessionForCwd', () => {
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
