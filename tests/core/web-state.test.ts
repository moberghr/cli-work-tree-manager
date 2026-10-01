import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ root: '' }));
vi.mock('../../src/core/history.js', () => ({
  findSessionById: (id: string) => (id === 's1' ? { target: 'api', branch: 'b', isGroup: false, paths: [h.root], createdAt: '', lastAccessedAt: '' } : null),
  loadHistory: () => [],
}));

import { disposeAllWatchers, subscribeSession } from '../../src/core/web-state.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-state-'));
  fs.mkdirSync(path.join(h.root, 'src'));
  fs.mkdirSync(path.join(h.root, 'node_modules', 'pkg'), { recursive: true });
});
afterEach(() => {
  disposeAllWatchers();
  fs.rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('subscribeSession (the Diff tab’s live updates)', () => {
  it('fires for an edit in the worktree, not for one in node_modules, and stops with the last subscriber', async () => {
    const onChange = vi.fn();
    const off = subscribeSession('s1', onChange);
    await wait(300); // the watch is up
    fs.writeFileSync(path.join(h.root, 'node_modules', 'pkg', 'index.js'), 'x');
    await wait(600);
    expect(onChange).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(h.root, 'src', 'a.ts'), 'x');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
    off();
    onChange.mockClear();
    fs.writeFileSync(path.join(h.root, 'src', 'b.ts'), 'y');
    await wait(600);
    expect(onChange).not.toHaveBeenCalled();
  }, 15_000);

  it('an unknown session gets a no-op', () => {
    expect(() => subscribeSession('nope', () => {})()).not.toThrow();
  });
});
