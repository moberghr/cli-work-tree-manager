// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BuildFoldersState } from '../../src/core/api-types.js';
import { BuildFolders, formatBytes, type BuildFoldersApi } from '../../src/web/src/components/Dashboard/tabs/BuildFolders.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const STATE: BuildFoldersState = {
  scanning: false,
  checked: 1,
  total: 1,
  scannedAt: new Date().toISOString(),
  candidates: [
    {
      sessionId: 's1',
      target: 'web',
      branch: 'fix/banner',
      lastActive: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      bytes: 2_400_000_000,
      folders: [{ path: 'C:/wt/web/node_modules', bytes: 2_400_000_000 }],
    },
  ],
};

describe('BuildFolders', () => {
  it('lists idle worktrees with their build output, and clears one', async () => {
    const api: BuildFoldersApi = {
      state: vi.fn(async () => STATE),
      scan: vi.fn(async () => STATE),
      apply: vi.fn(async () => ({
        results: [{ sessionId: 's1', ok: true, removed: 1, message: 'Removed 1 folder(s)' }],
        state: { ...STATE, candidates: [] },
      })),
    };
    act(() => root.render(createElement(BuildFolders, { api })));
    await flush();
    expect(container.textContent).toContain('fix/banner');
    expect(container.textContent).toContain('2.4 GB · node_modules');
    const clear = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Clear')!;
    await act(async () => clear.click());
    expect(api.apply).toHaveBeenCalledWith(['s1']);
    expect(container.textContent).toContain('Cleared 1 worktree');
    expect(container.textContent).not.toContain('fix/banner');
  });

  it('formats sizes', () => {
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
    expect(formatBytes(812_000_000)).toBe('812 MB');
    expect(formatBytes(1500)).toBe('2 KB');
  });
});
