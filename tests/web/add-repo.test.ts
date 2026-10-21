// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ addRepoToSession: vi.fn(), fetchProjects: vi.fn() }));
vi.mock('../../src/web/src/api/panes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/panes.js')>()),
  addRepoToSession: (id: string, alias: string, base?: string) => api.addRepoToSession(id, alias, base),
  fetchProjects: () => api.fetchProjects(),
}));
const { addableRepos, addedRepoText, canAddRepo, headerRepos } = await import('../../src/web/src/state/add-repo.js');
const { sessionHeaderItems } = await import('../../src/web/src/state/session-header-menu.js');
const { sessionMenuItems } = await import('../../src/web/src/state/session-menu.js');
const { AddRepoDialog } = await import('../../src/web/src/components/Dashboard/AddRepoDialog.js');

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: 's1',
    target: 'shop',
    branch: 'feat/x',
    isGroup: true,
    folder: true,
    repos: ['backend', 'frontend'],
    paths: ['C:\\wt\\shop\\feat-x\\backend', 'C:\\wt\\shop\\feat-x\\frontend'],
    createdAt: '',
    lastAccessedAt: '',
    archivedAt: null,
    ...over,
  }) as SessionSummary;
const single = (over: Partial<SessionSummary> = {}) =>
  session({ target: 'api', isGroup: false, folder: false, repos: ['api'], paths: ['C:\\wt\\api\\feat-x'], ...over });

const headerActions = () => ({
  openTerminal: vi.fn(),
  reconnectTerminal: vi.fn(),
  ship: vi.fn(),
  catchUp: vi.fn(),
  timeline: vi.fn(),
  sendPrompt: vi.fn(),
  notes: vi.fn(),
  devStart: vi.fn(),
  devStop: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  addRepo: vi.fn(),
});
const railActions = () => ({
  setArchived: vi.fn(),
  openTerminal: vi.fn(),
  openEditor: vi.fn(),
  copyBranch: vi.fn(),
  remove: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  addRepo: vi.fn(),
});

describe('addableRepos', () => {
  it('the enrolled repos not in the session, in the order they came', () => {
    expect(addableRepos(['docs', 'backend', 'admin', 'frontend', 'api'], ['backend', 'frontend'])).toEqual(['docs', 'admin', 'api']);
  });
  it('case-blind, as aliases are; none left: empty', () => {
    expect(addableRepos(['Backend', 'docs'], ['backend'])).toEqual(['docs']);
    expect(addableRepos(['backend'], ['backend'])).toEqual([]);
  });
});

describe('canAddRepo / headerRepos', () => {
  it('a session folder that is not archived; never a row from a server before `folder`', () => {
    expect(canAddRepo(session())).toBe(true);
    expect(canAddRepo(session({ archivedAt: '2026-10-01T00:00:00Z' }))).toBe(false);
    expect(canAddRepo(single())).toBe(false);
    expect(canAddRepo(session({ folder: undefined }))).toBe(false);
  });
  it("a folder's repos: recorded, else its folders' names; a single repo's session shows none", () => {
    expect(headerRepos(session())).toEqual(['backend', 'frontend']);
    expect(headerRepos(session({ folder: undefined, repos: undefined }))).toEqual(['backend', 'frontend']);
    expect(headerRepos(single())).toEqual([]);
    expect(headerRepos(single({ folder: undefined, repos: undefined }))).toEqual([]);
  });
  it('the toast says where it went, and what a new branch was made from', () => {
    expect(addedRepoText('docs', { path: 'C:\\wt\\shop\\feat-x\\straumur-documentation', branch: 'feat/x', created: false })).toEqual({
      text: 'Added docs: ./straumur-documentation on feat/x',
    });
    expect(addedRepoText('docs', { path: '/wt/shop/feat-x/docs', branch: 'feat/x', created: true, from: 'main' })).toEqual({
      text: 'Added docs: ./docs on feat/x, made from main',
    });
  });
  it("what didn't go as it should once the repo was in: said, as a warning", () => {
    expect(
      addedRepoText('docs', { path: '/wt/x/docs', branch: 'feat/x', created: false, warnings: ["couldn't tell its Claude: down", 'x'] }),
    ).toEqual({ text: "Added docs: ./docs on feat/x — but couldn't tell its Claude: down; x", kind: 'error' });
  });
});

describe('Add a repo… in the menus', () => {
  const header = (s: SessionSummary) => sessionHeaderItems(s, null, headerActions()).map((i) => i.label);
  const rail = (s: SessionSummary) => sessionMenuItems(s, railActions()).map((i) => i.label);

  it('offered for a session folder, with its key, and runs its action', () => {
    const a = headerActions();
    const item = sessionHeaderItems(session(), null, a).find((i) => i.label === 'Add a repo…')!;
    expect(item.hint).toBe('⇧A');
    item.run();
    expect(a.addRepo).toHaveBeenCalledTimes(1);
    const r = railActions();
    const s = session();
    sessionMenuItems(s, r)
      .find((i) => i.label === 'Add a repo…')!
      .run();
    expect(r.addRepo).toHaveBeenCalledWith(s);
  });

  it('not for an old single-repo session, an archived one, or a row from an older server', () => {
    for (const s of [single(), session({ archivedAt: '2026-10-01T00:00:00Z' }), session({ folder: undefined })]) {
      expect(header(s)).not.toContain('Add a repo…');
      expect(rail(s)).not.toContain('Add a repo…');
    }
  });

  it('not without the action (a view that cannot open the dialog)', () => {
    const { addRepo: _addRepo, ...rest } = headerActions();
    expect(sessionHeaderItems(session(), null, rest).map((i) => i.label)).not.toContain('Add a repo…');
  });
});

describe('AddRepoDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    api.addRepoToSession.mockReset();
    api.fetchProjects.mockReset();
    api.fetchProjects.mockResolvedValue({
      singles: [{ name: 'backend' }, { name: 'docs' }, { name: 'frontend' }, { name: 'admin' }].map((p) => ({ ...p, kind: 'single' })),
      groups: [],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const submit = () =>
    act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

  it('lists the repos not in the session, adds the one picked with the base, busy until it is done', async () => {
    let resolve!: (v: unknown) => void;
    api.addRepoToSession.mockReturnValue(new Promise((r) => (resolve = r)));
    const onAdded = vi.fn();
    await act(async () => root.render(createElement(AddRepoDialog, { session: session(), onAdded, onClose: () => {} })));
    const options = [...container.querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['docs', 'admin']);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const base = container.querySelector<HTMLInputElement>('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(base, ' develop ');
      base.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit();
    expect(api.addRepoToSession).toHaveBeenCalledWith('s1', 'docs', 'develop');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Checking docs out');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe('Adding…');
    const wire = { ok: true, path: 'C:\\wt\\shop\\feat-x\\docs', branch: 'feat/x', created: true, from: 'develop' };
    await act(async () => resolve(wire));
    expect(onAdded).toHaveBeenCalledWith('docs', wire);
  });

  it("shows the server's refusal and lets you try again", async () => {
    api.addRepoToSession.mockRejectedValue(new Error('docs: a folder named docs is in this session already'));
    const onAdded = vi.fn();
    await act(async () => root.render(createElement(AddRepoDialog, { session: session(), onAdded, onClose: () => {} })));
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('docs: a folder named docs is in this session already');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('every repo in it already: says so, nothing to add', async () => {
    await act(async () =>
      root.render(
        createElement(AddRepoDialog, {
          session: session({ repos: ['backend', 'docs', 'frontend', 'admin'], paths: ['a', 'b', 'c', 'd'] }),
          onAdded: () => {},
          onClose: () => {},
        }),
      ),
    );
    expect(container.textContent).toContain('in this session already');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });
});
