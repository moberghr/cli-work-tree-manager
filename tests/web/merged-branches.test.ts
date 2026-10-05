// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BranchesState } from '../../src/core/api-types.js';
import { MergedBranches, type MergedBranchesApi } from '../../src/web/src/components/Dashboard/tabs/MergedBranches.js';

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
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

const STATE: BranchesState = {
  scanning: false,
  scannedAt: new Date().toISOString(),
  candidates: [
    { repo: 'api', repoPath: 'C:/repos/api', branch: 'feat/merged', tip: 'a'.repeat(40), reason: 'merged' },
    { repo: 'api', repoPath: 'C:/repos/api', branch: 'feat/squashed', tip: 'b'.repeat(40), reason: 'squash-merged', prNumber: 7 },
    { repo: 'web', repoPath: 'C:/repos/web', branch: 'feat/old', tip: 'c'.repeat(40), reason: 'merged', archivedSession: 'arch1' },
  ],
};

function fakeApi(): MergedBranchesApi {
  return {
    state: vi.fn(async () => STATE),
    scan: vi.fn(async () => STATE),
    apply: vi.fn(async (items) => ({
      results: items.map((i: { repo: string; branch: string }) => ({ repo: i.repo, branch: i.branch, ok: true, message: 'Deleted' })),
      state: {
        ...STATE,
        candidates: STATE.candidates.filter(
          (c) => !items.some((i: { repo: string; branch: string }) => i.repo === c.repo && i.branch === c.branch),
        ),
      },
    })),
  };
}

describe('MergedBranches', () => {
  it('lists why each is safe, and warns when an archived session uses one', async () => {
    act(() => root.render(createElement(MergedBranches, { api: fakeApi() })));
    await flush();
    expect(container.textContent).toContain('squash-merged in #7');
    expect(container.textContent).toContain('an archived session uses it');
  });

  it("the bulk delete asks twice and leaves out the archived session's branch", async () => {
    const api = fakeApi();
    act(() => root.render(createElement(MergedBranches, { api })));
    await flush();
    act(() => button('Delete 2')!.click());
    expect(api.apply).not.toHaveBeenCalled();
    await act(async () => button('Really delete 2?')!.click());
    expect(api.apply).toHaveBeenCalledWith([
      { repo: 'api', branch: 'feat/merged', tip: 'a'.repeat(40) },
      { repo: 'api', branch: 'feat/squashed', tip: 'b'.repeat(40) },
    ]);
    expect(container.textContent).toContain('Deleted 2 branches.');
    expect(container.textContent).not.toContain('feat/merged');
    expect(container.textContent).toContain('feat/old');
  });

  it('says which were kept, and why', async () => {
    const api = fakeApi();
    api.apply = vi.fn(async () => ({
      results: [{ repo: 'web', branch: 'feat/old', ok: false, message: 'moved since the scan' }],
      state: STATE,
    }));
    act(() => root.render(createElement(MergedBranches, { api })));
    await flush();
    const del = [...container.querySelectorAll('li button')].at(-1) as HTMLButtonElement;
    await act(async () => del.click());
    expect(api.apply).toHaveBeenCalledWith([{ repo: 'web', branch: 'feat/old', tip: 'c'.repeat(40) }]);
    expect(container.textContent).toContain('1 kept: feat/old (moved since the scan)');
  });
});
