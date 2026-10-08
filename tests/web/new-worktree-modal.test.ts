// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectSummary } from '../../src/web/src/api/panes.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ createWorktree: vi.fn(), checkBranch: vi.fn() }));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchProjects: async () => ({
    groups: [{ name: 'straumur', kind: 'group', members: ['straumur-backend', 'straumur-frontend'] }],
    singles: [
      { name: 'jobly', kind: 'single', path: 'C:/repos/jobly' },
      { name: 'straumur-backend', kind: 'single', path: 'C:/repos/straumur-backend-ai' },
      { name: 'work-tree', kind: 'single', path: 'C:/repos/work-tree' },
    ],
  }),
  createWorktree: (req: unknown) => api.createWorktree(req),
  fetchBranchCheck: (t: string, b: string) => api.checkBranch(t, b),
  lookupPr: () => Promise.reject(new Error('not in tests: pass findPr')),
}));
const { NewWorktreeModal, branchNote, moreLabel } = await import('../../src/web/src/components/Sidebar/NewWorktreeModal.js');
const { matchProjects } = await import('../../src/web/src/components/Sidebar/ProjectPicker.js');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.createWorktree.mockReset().mockResolvedValue({ sessionId: 's1', launchDir: 'x', paths: ['x'] });
  // By default every branch is new.
  api.checkBranch
    .mockReset()
    .mockImplementation(async (_t: string, b: string) => ({ branch: b, valid: true, exists: false, session: null, free: b }));
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
const picker = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = () => [...container.querySelectorAll('[role="option"]')].map((o) => o.firstElementChild!.textContent);
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const submit = () =>
  act(async () => void container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

async function open(props: Record<string, unknown> = {}) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  act(() => root.render(createElement(NewWorktreeModal, { onCreated, onClose, ...props })));
  await flush();
  return { onCreated, onClose };
}

describe('the project field', () => {
  it('every word must match the name, a group’s repos or the folder', () => {
    const all: ProjectSummary[] = [
      { name: 'straumur', kind: 'group', members: ['straumur-backend', 'straumur-frontend'] },
      { name: 'jobly', kind: 'single', path: 'C:/repos/jobly' },
      { name: 'straumur-backend', kind: 'single', path: 'C:/repos/straumur-backend-ai' },
    ];
    expect(matchProjects(all, 'job').map((p) => p.name)).toEqual(['jobly']);
    expect(matchProjects(all, 'Straumur FRONT').map((p) => p.name)).toEqual(['straumur']);
    expect(matchProjects(all, 'backend-ai').map((p) => p.name)).toEqual(['straumur-backend']);
    expect(matchProjects(all, '  ').length).toBe(3);
  });

  it('type to narrow, ↓ and Enter to pick (not submitting), Escape closes the list but not the dialog', async () => {
    const { onClose } = await open();
    await act(async () => picker().focus());
    await act(async () => type(picker(), 'work'));
    expect(options()).toEqual(['work-tree']);
    await act(async () => void key(picker(), 'Enter'));
    expect(picker().value).toBe('work-tree');
    expect(api.createWorktree).not.toHaveBeenCalled();
    await act(async () => type(picker(), 'stra'));
    await act(async () => void key(picker(), 'ArrowDown'));
    await act(async () => void key(picker(), 'Enter'));
    expect(picker().value).toBe('straumur-backend');
    await act(async () => type(picker(), 'zzz'));
    expect(container.textContent).toContain('No project matches');
    await act(async () => void key(picker(), 'Escape'));
    expect(picker().value).toBe('straumur-backend'); // back to what was picked
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the branch is optional for a repo', () => {
  it('left empty: opens the project as it is (no branch sent)', async () => {
    await open({ initial: { target: 'jobly' } });
    await submit();
    expect(api.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ target: 'jobly', branch: '' }));
  });

  it('the Create button works with no branch: a project is all it needs (reported: stayed disabled)', async () => {
    await open({ initial: { target: 'timesheet' } });
    const create = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(create.disabled).toBe(false);
    await act(async () => create.click());
    expect(api.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ target: 'timesheet', branch: '' }));
  });

  it('the Create button waits for a project (a blank one is none)', async () => {
    await open({ initial: { target: '  ' } });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it('a group still needs one; and a base needs a branch', async () => {
    await open({ initial: { target: 'straumur' } });
    await submit();
    expect(api.createWorktree).not.toHaveBeenCalled();
    expect(container.textContent).toContain('straumur is a group: give it a branch');
    act(() => root.unmount());
    root = createRoot(container);
    await open({ initial: { target: 'jobly', base: 'dev' } });
    await submit();
    expect(api.createWorktree).not.toHaveBeenCalled();
    expect(container.textContent).toContain('A base needs a branch');
  });
});

describe('what Claude should do, and the branch it suggests', () => {
  const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
  const typeArea = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (label: string | RegExp) =>
    [...container.querySelectorAll('button')].find((b) =>
      typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''),
    )!;

  it('two fields: the branch follows the prompt, and the button says it starts Claude', async () => {
    await open({ initial: { target: 'jobly' } });
    expect(container.querySelectorAll('.wd-modal-row')).toHaveLength(2); // Project, What should Claude do?
    expect(container.textContent).toContain('Leave it empty to just make the worktree.');
    await act(async () => typeArea('Add CSV export to the invoices endpoint'));
    expect(container.querySelector('.wd-modal-branch code')!.textContent).toBe('feat/csv-export-invoices');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe('Create and start');
    await submit();
    expect(api.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'jobly', branch: 'feat/csv-export-invoices', prompt: 'Add CSV export to the invoices endpoint' }),
    );
  });

  it('Edit: your own branch, which the prompt no longer changes', async () => {
    await open({ initial: { target: 'jobly' } });
    await act(async () => typeArea('Fix the login redirect'));
    await act(async () => button('Edit').click());
    const input = container.querySelector<HTMLInputElement>('input[placeholder^="feat/whatever"]')!;
    expect(input.value).toBe('fix/login-redirect');
    await act(async () => type(input, 'fix/sso-loop'));
    await act(async () => typeArea('Fix the login redirect, and add a test'));
    expect(input.value).toBe('fix/sso-loop');
  });

  it('a pick that names its branch (Jira, a PR) keeps it', async () => {
    await open({ initial: { target: 'jobly', branch: 'feat/PAY-12', prompt: 'Work on PAY-12: retries' } });
    expect(container.querySelector('.wd-modal-branch code')!.textContent).toBe('feat/PAY-12');
  });

  it('name and base wait under More options (open when a pick gave a base)', async () => {
    await open({ initial: { target: 'jobly' } });
    expect(container.textContent).not.toContain('Base branch');
    await act(async () => button(/More options/).click());
    expect(container.textContent).toContain('Name (optional)');
    expect(container.textContent).toContain('Base branch (optional)');
    act(() => root.unmount());
    root = createRoot(container);
    await open({ initial: { target: 'jobly', branch: 'feat/x', base: 'dev' } });
    expect(container.textContent).toContain('Base branch (optional)');
  });
});

describe('a branch that is not new', () => {
  const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
  const typeArea = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  };
  /** Past the dialog's pause before it asks. */
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
  const button = (label: string | RegExp) =>
    [...container.querySelectorAll('button')].find((b) =>
      typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''),
    )!;

  it('a suggestion that is taken gives way to a free name, and says why; that name is what is created', async () => {
    api.checkBranch.mockImplementation(async (_t: string, b: string) => ({
      branch: b,
      valid: true,
      exists: true,
      session: null,
      free: `${b}-2`,
    }));
    await open({ initial: { target: 'jobly' } });
    await act(async () => typeArea('Fix tests'));
    await settle();
    expect(api.checkBranch).toHaveBeenCalledWith('jobly', 'fix/tests');
    expect(container.querySelector('.wd-modal-branch code')!.textContent).toBe('fix/tests-2');
    expect(container.querySelector('.wd-modal-branch-note')!.textContent).toBe('fix/tests is taken, so a new one: fix/tests-2.');
    await submit();
    expect(api.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ branch: 'fix/tests-2' }));
  });

  it('created before the check came back: it asks first, so a suggestion never lands on a taken branch', async () => {
    api.checkBranch.mockImplementation(async (_t: string, b: string) => ({
      branch: b,
      valid: true,
      exists: true,
      session: null,
      free: `${b}-2`,
    }));
    await open({ initial: { target: 'jobly' } });
    await act(async () => typeArea('Fix tests'));
    await submit(); // within the pause
    expect(api.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ branch: 'fix/tests-2' }));
  });

  it('a branch you typed that has a session: Create goes on with it, and says so', async () => {
    api.checkBranch.mockImplementation(async (_t: string, b: string) => ({
      branch: b,
      valid: true,
      exists: true,
      session: { id: 'old', archived: false },
      free: `${b}-2`,
    }));
    await open({ initial: { target: 'jobly', branch: 'fix/tests' } });
    await settle();
    expect(container.querySelector('.wd-modal-branch code')!.textContent).toBe('fix/tests'); // yours stays
    expect(container.querySelector('.wd-modal-branch-note')!.textContent).toContain('already has a session');
  });

  it('a name git refuses: Create waits for another', async () => {
    api.checkBranch.mockImplementation(async (_t: string, b: string) => ({
      branch: b,
      valid: false,
      exists: false,
      session: null,
      free: null,
    }));
    await open({ initial: { target: 'jobly', branch: 'fix/' } });
    await settle();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it('Ctrl+Enter in the prompt creates; Enter is a new line', async () => {
    await open({ initial: { target: 'jobly' } });
    await act(async () => typeArea('Add CSV export'));
    await act(async () => void textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(api.createWorktree).not.toHaveBeenCalled();
    await act(
      async () =>
        void textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })),
    );
    await settle();
    expect(api.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feat/csv-export', prompt: 'Add CSV export' }));
  });

  it('folded More options still says what is set in it, and opens when its base is the problem', async () => {
    await open({ initial: { target: 'jobly', base: 'dev' } });
    act(() => button(/More options/).click()); // fold it
    expect(button(/More options/).textContent).toBe('▸ More options: base dev');
    await submit(); // a base and no branch (no prompt)
    expect(container.textContent).toContain('A base needs a branch');
    expect(container.textContent).toContain('Base branch (optional)');
  });
});

describe('branchNote and moreLabel', () => {
  const c = (over: object) => ({ branch: 'b', valid: true, exists: false, session: null, free: 'b', ...over });
  it('says what Create will do with a branch that is not new', () => {
    expect(branchNote(c({}), true)).toBeNull();
    expect(branchNote(c({}), false)).toBeNull();
    expect(branchNote(c({ free: null, exists: true }), true)).toMatchObject({ blocks: true });
    expect(branchNote(c({ session: { id: 's', archived: true } }), false)!.text).toContain('restores it');
    expect(branchNote(c({ exists: true }), false)!.text).toContain('checks it out');
    expect(branchNote(c({ valid: false, free: null }), false)).toMatchObject({ blocks: true });
  });
  it('names what a folded More options holds', () => {
    expect(moreLabel('', '')).toBe('More options: name, base branch');
    expect(moreLabel('PDF speed', 'dev')).toBe('More options: name “PDF speed” · base dev');
  });
});

describe('start from a pull request', () => {
  const pr = {
    alias: 'jobly',
    number: 1927,
    title: 'Faster payouts',
    url: 'https://github.com/acme/jobly/pull/1927',
    branch: 'feat/payouts',
    base: 'main',
    author: 'ana',
  };
  const link = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Start from a pull request…')!;
  const prInput = () => container.querySelector<HTMLInputElement>('input[placeholder^="https://github.com/"]')!;

  it('a link fills in its repo, their branch and a first prompt saying whose branch it is; Create sends them', async () => {
    const findPr = vi.fn(async () => pr);
    await open({ findPr });
    await act(async () => link().click());
    await act(async () => type(prInput(), pr.url));
    await act(async () => void key(prInput(), 'Enter'));
    await flush();
    expect(findPr).toHaveBeenCalledWith(pr.url, undefined); // a link names its repo: the picked project isn't sent
    expect(picker().value).toBe('jobly');
    expect(container.querySelector('[role="status"]')!.textContent).toContain(
      'PR #1927 by @ana: Faster payouts. On their branch feat/payouts: what you push lands in their PR',
    );
    expect(container.querySelector('textarea')!.value).toContain("@ana's branch: what you commit and push lands in their PR");
    expect(api.createWorktree).not.toHaveBeenCalled(); // Enter in the PR field looks it up; it doesn't create
    await submit();
    expect(api.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'jobly', branch: 'feat/payouts', prompt: expect.stringContaining('Work on PR #1927 by @ana') }),
    );
  });

  it('a number is looked up in the project picked; a refusal shows why and changes nothing', async () => {
    const findPr = vi.fn(async () => {
      throw new Error("PR #12 comes from a fork (stranger): its branch isn't on origin, so a session couldn't push to it.");
    });
    await open({ findPr, initial: { target: 'work-tree' } });
    await act(async () => link().click());
    await act(async () => type(prInput(), '#12'));
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Use it')!.click());
    await flush();
    expect(findPr).toHaveBeenCalledWith('#12', 'work-tree');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('comes from a fork');
    expect(picker().value).toBe('work-tree');
    expect(container.querySelector('textarea')!.value).toBe('');
  });

  it('while it looks the PR up, the project and prompt wait (an answer would overwrite them)', async () => {
    let answer: (v: typeof pr) => void = () => {};
    await open({ findPr: vi.fn(() => new Promise<typeof pr>((r) => (answer = r))) });
    await act(async () => link().click());
    await act(async () => type(prInput(), '#1927'));
    await act(async () => void key(prInput(), 'Enter'));
    expect(picker().disabled).toBe(true);
    expect(container.querySelector('textarea')!.disabled).toBe(true);
    await act(async () => answer(pr));
    await flush();
    expect(picker().disabled).toBe(false);
    expect(container.querySelector('textarea')!.disabled).toBe(false);
  });

  it('the note goes when the project no longer matches the PR', async () => {
    await open({ findPr: vi.fn(async () => pr) });
    await act(async () => link().click());
    await act(async () => type(prInput(), '#1927'));
    await act(async () => void key(prInput(), 'Enter'));
    await flush();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => picker().focus());
    await act(async () => type(picker(), 'work'));
    await act(async () => void key(picker(), 'Enter'));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
