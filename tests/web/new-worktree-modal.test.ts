// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectSummary } from '../../src/web/src/api/panes.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ createWorktree: vi.fn() }));
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
}));
const { NewWorktreeModal } = await import('../../src/web/src/components/Sidebar/NewWorktreeModal.js');
const { matchProjects } = await import('../../src/web/src/components/Sidebar/ProjectPicker.js');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.createWorktree.mockReset().mockResolvedValue({ sessionId: 's1', launchDir: 'x', paths: ['x'] });
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
