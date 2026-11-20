import { describe, expect, it, vi } from 'vitest';
import { removeChildArgs, removedOf, removeWorktreeInChild, WORKTREE_REMOVED } from '../../../src/core/worktree/remove-child.js';
import type { ChildRun } from '../../../src/core/worktree/setup-child.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import { collectingReporter, withReporter } from '../../../src/core/platform/report.js';

/** Archive's worktree removal, run in a child so its git doesn't hold work web up. */
const session = {
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/wt/x'],
  createdAt: 'x',
  lastAccessedAt: 'x',
} as WorktreeSession;
const ran = (over: Partial<ChildRun>): ChildRun => ({ stdout: '', stderr: '', code: 0, timedOut: false, ...over });

describe('removedOf', () => {
  it('reads the child’s last word on it, whatever it printed before; nothing said is unknown', () => {
    expect(removedOf(`Removing…\n  Removed worktree: /wt/x\n${WORKTREE_REMOVED}true\n`)).toBe(true);
    expect(removedOf(`${WORKTREE_REMOVED}false\r\n`)).toBe(false);
    expect(removedOf(`${WORKTREE_REMOVED}true\n${WORKTREE_REMOVED}false\n`)).toBe(false);
    expect(removedOf('Removing…\n')).toBeNull();
    expect(removedOf(`${WORKTREE_REMOVED}maybe`)).toBeNull();
  });
});

describe('removeChildArgs', () => {
  it('names the session after `--`, so a name can’t read as a flag; its folders come from its row', () => {
    expect(removeChildArgs(session)).toEqual(['remove', '--worktree-only', '--', 'api', 'feat/x']);
    expect(removeChildArgs({ target: 'api', branch: '--force' })).toEqual(['remove', '--worktree-only', '--', 'api', '--force']);
  });
});

describe('removeWorktreeInChild', () => {
  it('runs work’s own binary on the session and answers as the removal did', async () => {
    const run = vi.fn(async () => ran({ stdout: `${WORKTREE_REMOVED}true\n` }));
    expect(await removeWorktreeInChild(() => '/bin/work.js', { run })(session)).toBe(true);
    expect(run).toHaveBeenCalledWith('/bin/work.js', ['remove', '--worktree-only', '--', 'api', 'feat/x']);
    const kept = removeWorktreeInChild(() => 'w', { run: async () => ran({ stdout: `${WORKTREE_REMOVED}false\n`, code: 0 }) });
    expect(await kept(session)).toBe(false);
  });

  it('a child that never answered counts as not removed, and says why: the archive keeps the worktree', async () => {
    const said = async (r: ChildRun) => {
      const reporter = collectingReporter();
      const removed = await withReporter(reporter, () => removeWorktreeInChild(() => 'w', { run: async () => r })(session));
      return { removed, text: reporter.entries.map((e) => e.text).join('\n') };
    };
    expect(await said(ran({ timedOut: true, code: null }))).toEqual({
      removed: false,
      text: "Couldn't remove the worktree of api feat/x: it took too long and was stopped",
    });
    expect((await said(ran({ spawnError: 'spawn node ENOENT', code: null }))).text).toContain('spawn node ENOENT');
    expect((await said(ran({ stderr: 'No config: run `work init` first.\n', code: 1 }))).text).toContain('No config');
    expect((await said(ran({ code: 3 }))).text).toContain('it ended with code 3');
  });
});
