// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SetupWire } from '../../src/core/api-types.js';
import { createDemoRepos } from '../../src/server/demo/demo-repos.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { WelcomeTab } = await import('../../src/web/src/components/Dashboard/tabs/WelcomeTab.js');
const { needsSetup, blockingTools } = await import('../../src/web/src/state/setup.js');

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
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
const section = (name: string) => container.querySelector(`section[aria-label="${name}"]`);
const tools: SetupWire['tools'] = [
  { id: 'git', label: 'git', needed: true, ok: true, detail: 'git version 2.47.0' },
  { id: 'claude', label: 'Claude Code', needed: true, ok: false, detail: 'Install Claude Code' },
  { id: 'gh', label: 'GitHub CLI', needed: false, ok: false, detail: 'Optional: install gh' },
];
const fresh: SetupWire = {
  configured: false,
  worktreesRoot: null,
  reposFolder: null,
  repos: 0,
  sessions: 0,
  suggested: { reposFolder: 'C:\\Users\\ana\\source\\repos', worktreesRoot: 'C:\\Users\\ana\\source\\worktrees' },
  tools,
};
const demo = createDemoRepos(() => []);
const reposApi = {
  load: async () => demo.inventory(),
  enroll: async () => {},
  remove: async () => {},
  ignore: async () => {},
  scanRoot: async () => {},
  saveGroup: async () => {},
  deleteGroup: async () => {},
};

describe('needsSetup', () => {
  it('no folders, or nothing to work on yet; a computer with sessions is set up', () => {
    expect(needsSetup({ configured: false, repos: 3, sessions: 1 })).toBe(true);
    expect(needsSetup({ configured: true, repos: 0, sessions: 0 })).toBe(true);
    expect(needsSetup({ configured: true, repos: 1, sessions: 0 })).toBe(false);
    expect(blockingTools({ tools })).toEqual(['Claude Code']);
  });
});

describe('Welcome', () => {
  it('a fresh computer: folders suggested, Use these folders saves them; no repos step yet; Start waits', async () => {
    let state = fresh;
    const save = vi.fn(async (wt: string, rf: string) => {
      state = { ...fresh, configured: true, worktreesRoot: wt, reposFolder: rf, tools: tools.map((t) => ({ ...t, ok: true })) };
    });
    const load = vi.fn(async () => state);
    act(() => root.render(createElement(WelcomeTab, { onNewWorktree: vi.fn(), onDone: vi.fn(), load, save, reposApi })));
    await flush();
    const inputs = section('Folders')!.querySelectorAll('input');
    expect(inputs[0].value).toBe('C:\\Users\\ana\\source\\repos');
    expect(inputs[1].value).toBe('C:\\Users\\ana\\source\\worktrees');
    expect(section('Your repos')).toBeNull();
    expect(button('New worktree').disabled).toBe(true);
    expect(section('Tools')!.textContent).toContain('Install Claude Code');

    act(() => button('Use these folders').click());
    await flush();
    expect(save).toHaveBeenCalledWith('C:\\Users\\ana\\source\\worktrees', 'C:\\Users\\ana\\source\\repos');
    // Set: the Repos step shows (the Repos page, inline), and the folders say so.
    expect(section('Your repos')!.querySelector('.wd-tab-repos')).not.toBeNull();
    expect(section('Folders')!.textContent).toContain('✓');
  });

  it('set up with a repo and the tools there: New worktree and Go to Start; Check again asks afresh', async () => {
    const load = vi.fn(async (_fresh?: boolean) => ({
      ...fresh,
      configured: true,
      worktreesRoot: '/wt',
      reposFolder: '/src',
      repos: 2,
      tools: tools.map((t) => ({ ...t, ok: true })),
    }));
    const onNewWorktree = vi.fn();
    const onDone = vi.fn();
    act(() => root.render(createElement(WelcomeTab, { onNewWorktree, onDone, load, save: vi.fn(), reposApi })));
    await flush();
    expect(button('New worktree').disabled).toBe(false);
    act(() => button('New worktree').click());
    act(() => button('Go to Start').click());
    expect(onNewWorktree).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
    act(() => button('Check again').click());
    await flush();
    expect(load).toHaveBeenLastCalledWith(true);
  });

  it('a refused save says why', async () => {
    const save = vi.fn(async () => {
      throw new Error("Repos folder: C:\\nope doesn't exist");
    });
    act(() => root.render(createElement(WelcomeTab, { onNewWorktree: vi.fn(), onDone: vi.fn(), load: async () => fresh, save, reposApi })));
    await flush();
    act(() => button('Use these folders').click());
    await flush();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("doesn't exist");
  });
});
