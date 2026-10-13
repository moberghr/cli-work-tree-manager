// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ParsedFile } from '../../src/web/src/api/client.js';
import { FileTree } from '../../src/web/src/components/Sidebar/FileTree.js';
import { tickOf, useViewedFiles, viewedFrom } from '../../src/web/src/hooks/use-viewed-files.js';
import { readScope } from '../../src/web/src/state/viewed-files.js';
import { filesUnder, keepReadingPlace, viewedMenuItems } from '../../src/web/src/state/tree-viewed.js';
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
      ['a', '1.0.s1'],
      ['b', '1.0.s2'],
      ['c', '1.0.s3'],
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
  it('a # in a path is part of the path: only a signature’s shape is read as one', () => {
    expect(tickOf('samples/C#/Foo.cs')).toEqual({ path: 'samples/C#/Foo.cs' });
    expect(tickOf('src/a#b.ts#3.1.k2x')).toEqual({ path: 'src/a#b.ts', signature: '3.1.k2x' });
    expect([...viewedFrom(new Set(['samples/C#/Foo.cs']), new Map())]).toEqual(['samples/C#/Foo.cs']);

    let hook!: ReturnType<typeof useViewedFiles>;
    function Harness() {
      hook = useViewedFiles('scope-y', new Map());
      return null;
    }
    act(() => root.render(createElement(Harness)));
    act(() => hook.setMany(['src/a#b.ts', 'samples/C#/Foo.cs'], true));
    act(() => hook.setMany(['src/a'], true));
    act(() => hook.setMany(['src/a'], false)); // leaves src/a#b.ts alone
    expect([...hook.viewedPaths].sort()).toEqual(['samples/C#/Foo.cs', 'src/a#b.ts']);
    act(() => hook.setMany(['src/a#b.ts', 'samples/C#/Foo.cs'], false));
    expect(readScope('scope-y').size).toBe(0); // and an emptied scope is pruned
    expect(localStorage.getItem('work-web:viewed-files')).toBe('{}');
  });
});

describe('the menu’s files stay the ones it was opened on', () => {
  it('a new diff closes the menu', () => {
    act(() => root.render(createElement(FileTree, { files, startIndex: 0, onMarkViewed: () => {} })));
    rightClick([...container.querySelectorAll('summary')].find((s) => s.textContent === 'src')!);
    expect(menuLabels()).toEqual(['Mark 3 files as viewed']);
    act(() => root.render(createElement(FileTree, { files: files.slice(1), startIndex: 4, onMarkViewed: () => {} })));
    expect(document.querySelector('.wd-row-menu')).toBeNull();
  });
});

describe('keepReadingPlace', () => {
  it('holds the file the reader is in where it was, after files above it collapse', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    const above = document.createElement('article');
    const reading = document.createElement('article');
    above.className = reading.className = 'wd-file';
    document.body.append(above, reading);
    let top = -200; // the reader is 200px into the file they read
    above.getBoundingClientRect = () => ({ top: -3000, bottom: -2000 }) as DOMRect;
    reading.getBoundingClientRect = () => ({ top, bottom: top + 900 }) as DOMRect;
    keepReadingPlace(() => {
      top = -1900; // the file above collapsed: everything moved up 1700px
    });
    while (frames.length) frames.shift()!(0);
    expect(scrollBy).toHaveBeenCalledWith(0, -1700);
    above.remove();
    reading.remove();
    vi.unstubAllGlobals();
  });

  it('in a scrolling pane, the file being read is the first below the pane’s top, not one hidden under the header', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
    const pane = document.createElement('div');
    pane.style.overflowY = 'auto';
    Object.defineProperties(pane, { scrollHeight: { value: 5000 }, clientHeight: { value: 600 } });
    pane.getBoundingClientRect = () => ({ top: 120 }) as DOMRect; // the header and toolbar above it
    pane.scrollBy = vi.fn() as never;
    const underHeader = document.createElement('article');
    const reading = document.createElement('article');
    underHeader.className = reading.className = 'wd-file';
    pane.append(underHeader, reading);
    document.body.append(pane);
    let top = 100;
    underHeader.getBoundingClientRect = () => ({ top: -400, bottom: 80 }) as DOMRect; // ends under the header
    reading.getBoundingClientRect = () => ({ top, bottom: top + 900 }) as DOMRect;
    keepReadingPlace(() => {
      top = -500; // files above it collapsed
    });
    while (frames.length) frames.shift()!(0);
    expect(pane.scrollBy).toHaveBeenCalledWith(0, -600);
    pane.remove();
    vi.unstubAllGlobals();
  });
});
