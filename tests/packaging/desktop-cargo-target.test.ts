import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sharedCargoTarget } from '../../desktop/scripts/cargo-target.mjs';

const main = path.resolve('/repos/work');
const worktree = path.join(main, '.claude', 'worktrees', 'feature');
const common = path.join(main, '.git');

describe('sharedCargoTarget', () => {
  it("points a worktree at the main checkout's target folder", () => {
    expect(sharedCargoTarget(worktree, common, {})).toBe(path.join(main, 'desktop', 'src-tauri', 'target'));
  });

  it('leaves the main checkout building where it always did', () => {
    expect(sharedCargoTarget(main, common, {})).toBeNull();
    expect(sharedCargoTarget(main + path.sep, common, {})).toBeNull();
  });

  it("keeps the user's own CARGO_TARGET_DIR, however the variable is cased", () => {
    expect(sharedCargoTarget(worktree, common, { CARGO_TARGET_DIR: '/elsewhere' })).toBeNull();
    expect(sharedCargoTarget(worktree, common, { Cargo_Target_Dir: 'D:\\t' })).toBeNull();
  });

  it('treats an empty CARGO_TARGET_DIR as unset', () => {
    expect(sharedCargoTarget(worktree, common, { CARGO_TARGET_DIR: '' })).not.toBeNull();
  });

  it('leaves Cargo alone when the main checkout cannot be told', () => {
    expect(sharedCargoTarget(worktree, null, {})).toBeNull();
    expect(sharedCargoTarget(worktree, path.resolve('/repos/work.git'), {})).toBeNull();
  });
});
