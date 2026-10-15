import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/pty/pty-pool.js', () => ({ disposePty: async () => {} }));

import { defaultCleanupDeps } from '../../../src/core/cleanup/cleanup-deps.js';
import { readArchive } from '../../../src/core/archive/session-archive.js';
import { loadHistory, saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import type { CommandRunner } from '../../../src/core/pr/ship.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-deps-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Clean up's archive", () => {
  it('archives through the one archive path, recorded as from Clean up', async () => {
    const wt = path.join(home, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    const s: WorktreeSession = { target: 'api', branch: 'feat/old', isGroup: false, paths: [wt], createdAt: 'x', lastAccessedAt: 'x' };
    saveHistory([s]);
    const id = sessionIdFor(s);
    const run: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' });
    await defaultCleanupDeps({ run }).act(
      { id, target: 'api', branch: 'feat/old', isGroup: false, paths: [wt], archivedAt: null, lastActiveMs: 0, aliases: ['api'] },
      'archive',
    );
    expect(loadHistory()[0].archivedAt).toBeTruthy();
    expect(readArchive(id)?.archivedBy).toBe('cleanup');
  });
});
