// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { badgeAsk, inTaskbarApp, newlyNeedingYou, readFlashOn, writeFlashOn } from '../../src/web/src/state/taskbar.js';
import { useTaskbar } from '../../src/web/src/hooks/use-taskbar.js';
import { HelpMenu } from '../../src/web/src/components/Dashboard/HelpMenu.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  delete (window as unknown as { __workDesktopTaskbar?: boolean }).__workDesktopTaskbar;
});

describe('the taskbar count and flash (pure)', () => {
  it('the ask for a count is digits the app reads: never negative, at most four', () => {
    expect(badgeAsk(3)).toBe('badge/3');
    expect(badgeAsk(0)).toBe('badge/0');
    expect(badgeAsk(-2)).toBe('badge/0');
    expect(badgeAsk(123456)).toBe('badge/9999');
    expect(badgeAsk(2.7)).toBe('badge/2');
  });

  it('a session newly waiting on you is news; one still waiting, or one that stopped, is not', () => {
    expect(newlyNeedingYou(new Set(['a']), new Set(['a', 'b']))).toBe(true);
    expect(newlyNeedingYou(new Set(['a', 'b']), new Set(['a']))).toBe(false);
    expect(newlyNeedingYou(new Set(['a']), new Set(['a']))).toBe(false);
  });

  it('the switch is on unless turned off; the marker says the app', () => {
    expect(readFlashOn()).toBe(true);
    writeFlashOn(false);
    expect(readFlashOn()).toBe(false);
    expect(inTaskbarApp()).toBe(false);
    (window as unknown as { __workDesktopTaskbar?: boolean }).__workDesktopTaskbar = true;
    expect(inTaskbarApp()).toBe(true);
  });
});

describe('useTaskbar', () => {
  function mount(inApp: boolean) {
    const go = vi.fn<(url: string) => void>();
    let hook!: ReturnType<typeof useTaskbar>;
    // One component, its props changed between renders (a new function each time would remount it).
    const props = { count: 0, waiting: new Set<string>() };
    function Harness() {
      hook = useTaskbar(props.count, props.waiting, go, inApp);
      return null;
    }
    const render = (count: number, waiting: string[]) => {
      props.count = count;
      props.waiting = new Set(waiting);
      act(() => root.render(createElement(Harness, { key: 'one', n: count })));
    };
    return { go, render, hook: () => hook };
  }

  it('in the app: the count on each change; a flash only for a session that starts waiting while it runs', () => {
    const { go, render } = mount(true);
    render(2, ['a']); // what was waiting when the app opened isn't news
    expect(go.mock.calls.map((c) => c[0])).toEqual(['http://work-desktop.invalid/badge/2']);
    render(3, ['a', 'b']);
    expect(go.mock.calls.map((c) => c[0]).slice(1)).toEqual([
      'http://work-desktop.invalid/badge/3',
      'http://work-desktop.invalid/attention',
    ]);
    render(1, []);
    expect(go.mock.calls.at(-1)?.[0]).toBe('http://work-desktop.invalid/badge/1');
  });

  it('the flash can be turned off; the count still shows', () => {
    const { go, render, hook } = mount(true);
    render(1, []);
    act(() => hook().setFlashOn(false));
    render(2, ['a']);
    expect(go.mock.calls.map((c) => c[0])).not.toContain('http://work-desktop.invalid/attention');
    expect(go.mock.calls.at(-1)?.[0]).toBe('http://work-desktop.invalid/badge/2');
    expect(readFlashOn()).toBe(false);
  });

  it('in a browser tab: nothing is asked', () => {
    const { go, render } = mount(false);
    render(2, ['a']);
    render(3, ['a', 'b']);
    expect(go).not.toHaveBeenCalled();
  });
});

describe('HelpMenu: the flash switch', () => {
  it('shows only in the app, and switches', () => {
    const set = vi.fn();
    act(() => root.render(createElement(HelpMenu, { taskbarFlash: { on: true, set } })));
    act(() => container.querySelector<HTMLButtonElement>('.wd-help-btn')!.click());
    const box = container.querySelector<HTMLInputElement>('.wd-help-toggle input')!;
    expect(box.checked).toBe(true);
    act(() => box.click());
    expect(set).toHaveBeenCalledWith(false);
    act(() => root.render(createElement(HelpMenu, {})));
    expect(container.querySelector('.wd-help-toggle')).toBeNull();
  });
});
