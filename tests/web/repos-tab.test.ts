// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RepoChangeError } from '../../src/web/src/api/panes.js';
import { createDemoRepos, DemoRepoError } from '../../src/server/demo/demo-repos.js';
import type { RepoRow } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { ReposTab, reposShown } = await import('../../src/web/src/components/Dashboard/tabs/ReposTab.js');
type ReposApi = NonNullable<Parameters<typeof ReposTab>[0]['api']>;

let container: HTMLDivElement;
let root: Root;
let live: string[];
let api: ReposApi & { calls: string[] };

/** The page over the demo's in-memory repos: the real rules, refusals as the HTTP calls throw them. */
function demoApi(): ReposApi & { calls: string[] } {
  const demo = createDemoRepos(() => live);
  const calls: string[] = [];
  const call = (name: string, fn: () => void) => async () => {
    calls.push(name);
    try {
      fn();
    } catch (e) {
      if (e instanceof DemoRepoError) throw new RepoChangeError(e.message, e.sessions);
      throw e;
    }
  };
  return {
    calls,
    load: async () => demo.inventory(),
    enroll: (a, p) => call(`enroll ${a}`, () => demo.enroll(a, p))(),
    remove: (a, force) => call(`remove ${a}${force ? ' force' : ''}`, () => demo.remove(a, !!force))(),
    ignore: (p, on) => call(`ignore ${p} ${on}`, () => demo.ignore(p, on))(),
    scanRoot: (p, on) => call(`root ${p} ${on}`, () => {})(),
    saveGroup: (n, m, c) => call(`group ${n} ${m.join('+')}${c ? ' new' : ''}`, () => demo.saveGroup(n, m, c))(),
    deleteGroup: (n, force) => call(`delete ${n}${force ? ' force' : ''}`, () => demo.deleteGroup(n, !!force))(),
  };
}

beforeEach(() => {
  live = [];
  api = demoApi();
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
const render = async () => {
  act(() => root.render(createElement(ReposTab, { api })));
  await flush();
};
const buttons = (scope: ParentNode = container) => [...scope.querySelectorAll('button')];
const button = (label: string, scope: ParentNode = container) => buttons(scope).find((b) => b.textContent === label)!;
const rowOf = (folder: string) =>
  [...container.querySelectorAll('.wd-repos-row')].find((r) => r.querySelector('.wd-repos-folder')?.textContent === folder)!;
const folders = () => [...container.querySelectorAll('.wd-tab-repos > .wd-repos-list .wd-repos-folder')].map((f) => f.textContent);
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const click = async (b: HTMLElement) => {
  act(() => b.click());
  await flush();
};

describe('reposShown', () => {
  const row = (folder: string, status: RepoRow['status'], alias: string | null = null): RepoRow => ({
    path: `/r/${folder}`,
    folder,
    origin: null,
    status,
    alias,
    groups: [],
    sessions: 0,
  });
  const rows = [row('api', 'enrolled', 'api'), row('old', 'missing', 'old'), row('billing', 'new'), row('tmp', 'ignored')];

  it('a missing repo is still enrolled; search matches every word', () => {
    expect(reposShown(rows, 'enrolled', '').map((r) => r.folder)).toEqual(['api', 'old']);
    expect(reposShown(rows, 'new', '').map((r) => r.folder)).toEqual(['billing']);
    expect(reposShown(rows, 'all', 'r/ bill').map((r) => r.folder)).toEqual(['billing']);
  });
});

describe('the Repos page', () => {
  it('opens on what is new, with each repo’s suggested alias; Add enrols it', async () => {
    await render();
    expect(folders()).toEqual(['billing', 'hangfire', 'wolverine']);
    const alias = rowOf('billing').querySelector<HTMLInputElement>('.wd-repos-alias')!;
    expect(alias.value).toBe('billing');
    await click(button('Add', rowOf('billing')));
    expect(api.calls).toEqual(['enroll billing']);
    expect(folders()).toEqual(['hangfire', 'wolverine']);
    expect(container.querySelector('h1')!.textContent).toContain('5 enrolled · 2 new');
  });

  it('checks the alias as you type: a taken one disables Add and says why', async () => {
    await render();
    const alias = rowOf('hangfire').querySelector<HTMLInputElement>('.wd-repos-alias')!;
    act(() => type(alias, 'api'));
    const add = button('Add', rowOf('hangfire'));
    expect(add.disabled).toBe(true);
    expect(rowOf('hangfire').querySelector('.wd-repos-error')!.textContent).toMatch(/already the alias/);
    act(() => type(alias, 'hf'));
    expect(button('Add', rowOf('hangfire')).disabled).toBe(false);
    await click(button('Add', rowOf('hangfire')));
    expect(api.calls).toEqual(['enroll hf']);
  });

  it('Ignore moves it to Ignored, and Unignore brings it back', async () => {
    await render();
    await click(button('Ignore', rowOf('wolverine')));
    expect(folders()).not.toContain('wolverine');
    await click(button('Ignored 1'));
    expect(folders()).toEqual(['wolverine']);
    await click(button('Unignore', rowOf('wolverine')));
    expect(api.calls).toEqual(['ignore ~/repos/wolverine true', 'ignore ~/repos/wolverine false']);
  });

  it('Remove with live sessions asks first, naming them; “Do it anyway” forces it', async () => {
    live = ['api'];
    await render();
    await click(button('Enrolled 4'));
    await click(button('Remove', rowOf('api')));
    expect(container.querySelector('.wd-repos-confirm')!.textContent).toMatch(/1 live session on api: api · …/);
    await click(button('Do it anyway'));
    expect(api.calls).toEqual(['remove api', 'remove api force']);
    expect(folders()).not.toContain('api');
  });
});

describe('groups on the Repos page', () => {
  const groups = () => container.querySelector('section[aria-label="Groups"]')!;
  const groupRow = (name: string) =>
    [...groups().querySelectorAll('.wd-repos-group')].find((r) => r.querySelector('.wd-repos-folder')?.textContent === name)!;

  it('a new group: a name and two repos, checked as you go', async () => {
    await render();
    const name = groups().querySelector<HTMLInputElement>('input[aria-label="New group name"]')!;
    act(() => type(name, 'pair'));
    const create = button('Create group', groups());
    expect(create.disabled).toBe(true);
    expect(groups().querySelector('.wd-repos-newgroup .wd-repos-error')!.textContent).toMatch(/at least two/);
    for (const a of ['api', 'web']) {
      const box = [...groups().querySelectorAll<HTMLLabelElement>('.wd-repos-pick label')].find((l) => l.textContent === a)!;
      act(() => box.querySelector('input')!.click());
    }
    await click(button('Create group', groups()));
    expect(api.calls).toEqual(['group pair api+web new']);
    expect(groupRow('pair').textContent).toContain('api');
    expect(name.value).toBe('');
  });

  it('a group’s repos change in place: × takes one out, + add puts one in', async () => {
    await render();
    const select = groupRow('shop').querySelector('select')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'api');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    await click(groupRow('shop').querySelector<HTMLButtonElement>('button[aria-label="Take backend out of shop"]')!);
    expect(api.calls).toEqual(['group shop backend+frontend+api', 'group shop frontend+api']);
  });

  it('taking it below two repos is refused and says why; Delete with sessions asks first', async () => {
    live = ['shop'];
    await render();
    await click(groupRow('shop').querySelector<HTMLButtonElement>('button[aria-label="Take backend out of shop"]')!);
    expect(groupRow('shop').querySelector('.wd-repos-error')!.textContent).toMatch(/at least two/);
    await click(button('Delete', groupRow('shop')));
    expect(container.querySelector('.wd-repos-confirm')!.textContent).toMatch(/live session on shop/);
    await click(button('Do it anyway'));
    expect(api.calls.slice(-2)).toEqual(['delete shop', 'delete shop force']);
    expect(groups().querySelectorAll('.wd-repos-group')).toHaveLength(0);
  });
});
