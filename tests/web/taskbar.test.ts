// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { badgeAsk, inTaskbarApp, newlyNeedingYou, readFlashOn, writeFlashOn } from '../../src/web/src/state/taskbar.js';
import { useTaskbar } from '../../src/web/src/hooks/use-taskbar.js';
import { ASK_GAP_MS, createAskQueue } from '../../src/web/src/state/desktop-asks.js';
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
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => {
    act(() => void vi.runAllTimers()); // the ask queue drains between tests
    vi.useRealTimers();
  });

  function mount(inApp: boolean) {
    const go = vi.fn<(url: string) => void>();
    let hook!: ReturnType<typeof useTaskbar>;
    // One component, its props changed between renders (a new function each time would remount it).
    const props = { count: 0, waiting: new Set<string>(), ready: false };
    function Harness() {
      hook = useTaskbar(props.count, props.waiting, { ready: props.ready, go, inApp });
      return null;
    }
    const render = (count: number, waiting: string[], ready = true) => {
      Object.assign(props, { count, waiting: new Set(waiting), ready });
      act(() => root.render(createElement(Harness, { key: 'one', n: count })));
      act(() => void vi.advanceTimersByTime(ASK_GAP_MS * 5)); // the queued asks go out, one by one
    };
    return { go, render, hook: () => hook, asked: () => go.mock.calls.map((c) => c[0]) };
  }

  it('nothing before the session list has come; then what was waiting is not news, a session that starts waiting is', () => {
    const { render, asked } = mount(true);
    render(0, [], false); // the page just opened: no list yet
    expect(asked()).toEqual([]);
    render(2, ['a']); // the list: 'a' was already waiting
    expect(asked()).toEqual(['http://work-desktop.invalid/badge/2']);
    render(3, ['a', 'b']);
    expect(asked().slice(1)).toEqual(['http://work-desktop.invalid/badge/3', 'http://work-desktop.invalid/attention']);
    render(1, []);
    expect(asked().at(-1)).toBe('http://work-desktop.invalid/badge/1');
  });

  it('the flash can be turned off; the count still shows', () => {
    const { render, hook, asked } = mount(true);
    render(1, []);
    act(() => hook().setFlashOn(false));
    render(2, ['a']);
    expect(asked()).not.toContain('http://work-desktop.invalid/attention');
    expect(asked().at(-1)).toBe('http://work-desktop.invalid/badge/2');
    expect(readFlashOn()).toBe(false);
  });

  it('in a browser tab: nothing is asked', () => {
    const { go, render } = mount(false);
    render(2, ['a']);
    render(3, ['a', 'b']);
    expect(go).not.toHaveBeenCalled();
  });
});

describe('the ask queue', () => {
  it('the first ask goes at once, the rest one at a time after it, in order (two at once can replace each other)', () => {
    const steps: Array<() => void> = [];
    const send = createAskQueue((fn) => void steps.push(fn));
    const went: string[] = [];
    const go = (url: string) => void went.push(url);
    send('hello', go);
    send('badge/2', go);
    send('attention', go);
    expect(went).toEqual(['hello']);
    steps.shift()!();
    expect(went).toEqual(['hello', 'badge/2']);
    steps.shift()!();
    steps.shift()!();
    expect(went).toEqual(['hello', 'badge/2', 'attention']);
    send('badge/3', go); // idle again: at once
    expect(went.at(-1)).toBe('badge/3');
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
