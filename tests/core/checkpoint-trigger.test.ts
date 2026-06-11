import { describe, it, expect } from 'vitest';
import { claudeActiveWithin } from '../../src/core/claude-activity.js';
import { scopeCoversCwd } from '../../src/core/scope-manager.js';

describe('claudeActiveWithin (timer suppression gate)', () => {
  it('is true when Claude wrote within the window', () => {
    expect(claudeActiveWithin(1_000, 2_000, 5_000)).toBe(true); // 1s ago
  });
  it('is false once the window has elapsed (no active session)', () => {
    expect(claudeActiveWithin(1_000, 10_000, 5_000)).toBe(false); // 9s ago
  });
  it('is false when there is no transcript at all (activity 0)', () => {
    expect(claudeActiveWithin(0, 5_000, 5_000)).toBe(false);
  });
});

describe('scopeCoversCwd (Stop-hook cwd → scope match)', () => {
  const repo = 'C:/work/worktrees/app/feat-x';
  it('matches a single-repo worktree exactly', () => {
    expect(scopeCoversCwd([repo], repo)).toBe(true);
  });
  it('matches when cwd is the group root containing the sub-repos', () => {
    const group = 'C:/work/worktrees/grp/feat';
    expect(
      scopeCoversCwd([`${group}/backend`, `${group}/frontend`], group),
    ).toBe(true);
  });
  it('matches when cwd is nested inside a repo root', () => {
    expect(scopeCoversCwd([repo], `${repo}/src/web`)).toBe(true);
  });
  it('is case/-slash-insensitive (Windows paths)', () => {
    expect(scopeCoversCwd(['C:\\work\\app'], 'c:/WORK/app')).toBe(true);
  });
  it('does not match an unrelated path', () => {
    expect(scopeCoversCwd([repo], 'C:/other/repo')).toBe(false);
  });
});
