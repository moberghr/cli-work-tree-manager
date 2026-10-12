// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ParsedFile } from '../../src/web/src/api/client.js';
import { FileTree } from '../../src/web/src/components/Sidebar/FileTree.js';
import { useViewedFiles } from '../../src/web/src/hooks/use-viewed-files.js';
import { filesUnder, viewedMenuItems } from '../../src/web/src/state/tree-viewed.js';
import { buildTree } from '../../src/web/src/utils/tree.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (path: string): ParsedFile =>
  ({ path, oldPath: path, newPath: path, status: 'modified', isBinary: false, added: 1, deleted: 0, hunks: [] }) as unknown as ParsedFile;
const files = [file('src/a.ts'), file('src/lib/b.ts'), file('src/lib/c.ts'), file('README.md')];

describe('the tree’s right-click: mark a folder’s files viewed', () => {
  it('a folder is every file under it, nested ones too; a file is itself', () => {
    const src = buildTree(files).find((n) => n.name === 'src')!;
    expect(filesUnder(src).map((f) => f.path)).toEqual(['src/a.ts', 'src/lib/b.ts', 'src/lib/c.ts']);
    expect(filesUnder(buildTree(files).find((n) => n.name === 'README.md')!)).toEqual([{ path: 'README.md', anchor: 'wd-file-3' }]);
  });

  it('offers only what changes something: viewed for those that aren’t, not viewed for those that are', () => {
    const mark = vi.fn();
    const three = [
      { path: 'x', anchor: 'wd-file-0' },
      { path: 'y', anchor: 'wd-file-1' },
      { path: 'z', anchor: 'wd-file-2' },
    ];
    const items = viewedMenuItems(three, new Set(['wd-file-1']), mark);
    expect(items.map((i) => i.label)).toEqual(['Mark 2 files as viewed', 'Mark 1 file as not viewed']);
    items[0].run();
    expect(mark).toHaveBeenLastCalledWith(['x', 'z'], true);
    items[1].run();
    expect(mark).toHaveBeenLastCalledWith(['y'], false);
    expect(viewedMenuItems(three, new Set(), mark).map((i) => i.label)).toEqual(['Mark 3 files as viewed']);
    expect(viewedMenuItems([three[0]], new Set(['wd-file-0']), mark).map((i) => i.label)).toEqual(['Mark as not viewed']);
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const rightClick = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
const menuLabels = () => [...document.querySelectorAll('.wd-row-menu-item')].map((b) => b.textContent);

describe('FileTree', () => {
  it('right-click on a folder opens the menu; a pick marks every file under it', () => {
    const onMarkViewed = vi.fn();
    act(() => root.render(createElement(FileTree, { files, startIndex: 0, viewedAnchors: new Set(['wd-file-1']), onMarkViewed })));
    const lib = [...container.querySelectorAll('summary')].find((s) => s.textContent === 'lib')!;
    rightClick(lib);
    expect(menuLabels()).toEqual(['Mark 1 file as viewed', 'Mark 1 file as not viewed']);
    act(() => document.querySelector<HTMLButtonElement>('.wd-row-menu-item')!.click());
    expect(onMarkViewed).toHaveBeenCalledWith(['src/lib/c.ts'], true);
    expect(document.querySelector('.wd-row-menu')).toBeNull();
  });

  it('a file has the menu too; without onMarkViewed nothing opens (the browser’s own menu stays)', () => {
    act(() => root.render(createElement(FileTree, { files, startIndex: 0, onMarkViewed: () => {} })));
    rightClick(container.querySelector('a[title="README.md"]')!);
    expect(menuLabels()).toEqual(['Mark as viewed']);
    act(() => root.render(createElement(FileTree, { files, startIndex: 0 })));
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      container.querySelector('a[title="src/a.ts"]')!.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('useViewedFiles: setMany', () => {
  it('marks several at once (each with its change) and unmarks them, leaving the others', () => {
    let hook!: ReturnType<typeof useViewedFiles>;
    const anchors = new Map([
      ['a', 'wd-file-0'],
      ['b', 'wd-file-1'],
      ['c', 'wd-file-2'],
    ]);
    const sigs = new Map([
      ['a', 's1'],
      ['b', 's2'],
      ['c', 's3'],
    ]);
    function Harness() {
      hook = useViewedFiles('scope-x', anchors, sigs);
      return null;
    }
    act(() => root.render(createElement(Harness)));
    act(() => hook.toggle('c', true));
    act(() => hook.setMany(['a', 'b'], true));
    expect([...hook.viewedPaths].sort()).toEqual(['a', 'b', 'c']);
    act(() => hook.setMany(['a', 'b'], false));
    expect([...hook.viewedPaths]).toEqual(['c']);
    expect([...hook.viewedAnchors]).toEqual(['wd-file-2']);
  });
});
