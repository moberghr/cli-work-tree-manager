import { describe, expect, it, vi } from 'vitest';
import { afterArchive } from '../../../src/core/archive/after-archive.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

const s: WorktreeSession = { target: 'api', branch: 'feat/parent', isGroup: false, paths: [], createdAt: 'x', lastAccessedAt: 'x' };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('afterArchive (what work web does after an archive)', () => {
  it('the real work web: stacked sessions move onto main, and the blocks waiting on it are swept', async () => {
    const retarget = vi.fn(async () => 2);
    const changed = vi.fn();
    const sweepBlocks = vi.fn(async () => {});
    afterArchive(s, { retarget, changed, sweepBlocks });
    await flush();
    expect(retarget).toHaveBeenCalledWith(sessionIdFor(s));
    expect(changed).toHaveBeenCalled();
    expect(sweepBlocks).toHaveBeenCalled();
  });

  it('the dev server: moves the stacked sessions (no one else hears of it), leaves the sweep to the real one', async () => {
    const retarget = vi.fn(async () => 0);
    const changed = vi.fn();
    afterArchive(s, { retarget, changed });
    await flush();
    expect(retarget).toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled(); // nothing moved
  });

  it("a failed move is logged, never the archive's trouble", async () => {
    afterArchive(s, { retarget: async () => Promise.reject(new Error('git')), changed: vi.fn() });
    await flush();
  });
});
