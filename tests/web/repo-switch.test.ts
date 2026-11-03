// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RepoSwitch } from '../../src/web/src/components/Diff/RepoSwitch.js';
import type { RepoSwitchItem } from '../../src/web/src/state/diff-view.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lays nothing out: the toolbar is given a width, a repo's pill ten pixels a letter, the list's button 30,
// anything else its data-w.
let toolbarWidth = 0;
let resized: (() => void) | null = null;
const widthOf = (el: Element): number => {
  const h = el as HTMLElement;
  if (h.dataset?.repo) return h.dataset.repo.length * 10;
  if (h.hasAttribute?.('data-more')) return 30;
  return Number(h.dataset?.w ?? 0);
};

let container: HTMLDivElement;
let root: Root;
const picked: string[] = [];

beforeEach(() => {
  picked.length = 0;
  toolbarWidth = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { width: widthOf(this), height: 20, top: 0, left: 0, right: widthOf(this), bottom: 20, x: 0, y: 0 } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'toolbar' ? toolbarWidth : 0;
    },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  resized = null;
});

const item = (name: string, files: number | null): RepoSwitchItem => ({ name, files, added: files ?? 0, deleted: 0 });
// Twenty repos (70 px each), three with changes.
const many = Array.from({ length: 20 }, (_, i) => {
  const name = `repo-${String(i + 1).padStart(2, '0')}`;
  return item(name, ['repo-03', 'repo-07', 'repo-12'].includes(name) ? 2 : 0);
});

/** The switch beside 100 px of other controls, in a toolbar `width` wide. */
async function renderSwitch(items: RepoSwitchItem[], active: string, width: number) {
  toolbarWidth = width;
  await act(async () => {
    root.render(
      createElement(
        'div',
        { role: 'toolbar' },
        createElement(RepoSwitch, { items, active, onPick: (n: string) => picked.push(n) }),
        createElement('div', { 'data-w': 100 }, 'Split | Unified'),
      ),
    );
  });
}

const pills = () =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-diff-repo-switch [role="tab"]')].map(
    (b) => `${b.textContent}${b.getAttribute('aria-selected') === 'true' ? ' *' : ''}`,
  );
const moreButton = () => container.querySelector<HTMLButtonElement>('.wd-diff-repo-more > .wd-diff-repo-more-btn');
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((b) => b.textContent);
const search = () => container.querySelector<HTMLInputElement>('.wd-diff-repo-search')!;
const type = async (text: string) => {
  const input = search();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const key = async (k: string) => {
  await act(async () => {
    search().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};

describe('RepoSwitch', () => {
  it('not laid out (a hidden tab): every repo is a pill, no list', async () => {
    await renderSwitch(many.slice(0, 3), 'repo-03', 0);
    expect(pills()).toEqual(['repo-01 0', 'repo-02 0', 'repo-03 2 *']);
    expect(moreButton()).toBeNull();
  });

  it('a few repos that fit: all of them, as always', async () => {
    await renderSwitch(many.slice(0, 3), 'repo-03', 1000);
    expect(pills()).toEqual(['repo-01 0', 'repo-02 0', 'repo-03 2 *']);
    expect(moreButton()).toBeNull();
  });

  it("too many: the changed ones that fit in what the rest of the line leaves, then '+N' for the others", async () => {
    // 300 − 100 for the controls − 3 (border, spare) − 30 for the button: two pills of 70.
    await renderSwitch(many, 'repo-03', 300);
    expect(pills()).toEqual(['repo-03 2 *', 'repo-07 2']);
    expect(moreButton()!.textContent).toBe('+18▾');
    // repo-12's changes are behind it.
    expect(moreButton()!.querySelector('.wd-diff-repo-more-dot')).not.toBeNull();
    expect(moreButton()!.title).toBe('18 more repos, 1 with changes — find one by name');
  });

  it('the repo on screen keeps its pill, one with no changes too', async () => {
    await renderSwitch(many, 'repo-15', 300);
    expect(pills()).toEqual(['repo-03 2', 'repo-15 0 *']);
  });

  it('a narrower window: fewer pills; no room for any, the button names the repo on screen', async () => {
    await renderSwitch(many, 'repo-07', 300);
    expect(pills()).toEqual(['repo-03 2', 'repo-07 2 *']);
    toolbarWidth = 150;
    await act(async () => resized?.());
    expect(pills()).toEqual([]);
    expect(moreButton()!.textContent).toBe('repo-07▾');
    expect(moreButton()!.classList.contains('wd-diff-repo-more-current')).toBe(true);
  });

  it('the list: every repo, changed first, found by typing; Enter picks', async () => {
    await renderSwitch(many, 'repo-03', 300);
    await act(async () => moreButton()!.click());
    expect(document.activeElement).toBe(search());
    expect(container.querySelector('[role="listbox"]')!.textContent).toContain('Changed · 3');
    expect(container.querySelector('[role="listbox"]')!.textContent).toContain('No changes · 17');
    expect(rows().slice(0, 4)).toEqual(['✓repo-032 files +2 −0', 'repo-072 files +2 −0', 'repo-122 files +2 −0', 'repo-01']);
    await type('1');
    expect(rows()).toEqual([
      'repo-122 files +2 −0',
      'repo-01',
      'repo-10',
      'repo-11',
      'repo-13',
      'repo-14',
      'repo-15',
      'repo-16',
      'repo-17',
      'repo-18',
      'repo-19',
    ]);
    await key('ArrowDown');
    await key('Enter');
    expect(picked).toEqual(['repo-01']);
    expect(container.querySelector('.wd-diff-repo-pop')).toBeNull();
  });

  it('nothing matches: says so; Escape closes it without leaving full screen', async () => {
    await renderSwitch(many, 'repo-03', 300);
    await act(async () => moreButton()!.click());
    await type('zzz');
    expect(container.querySelector('.wd-diff-repo-pop')!.textContent).toContain('No repo matches “zzz”');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => search().dispatchEvent(esc));
    expect(esc.defaultPrevented).toBe(true);
    expect(container.querySelector('.wd-diff-repo-pop')).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it('a click on a row picks it; a click elsewhere closes the list', async () => {
    await renderSwitch(many, 'repo-03', 300);
    await act(async () => moreButton()!.click());
    const row = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) => b.textContent === 'repo-20')!;
    await act(async () => row.click());
    expect(picked).toEqual(['repo-20']);
    await act(async () => moreButton()!.click());
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(container.querySelector('.wd-diff-repo-pop')).toBeNull();
  });
});
