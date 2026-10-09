// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UpdateWire } from '../../src/core/api-types.js';
import { HelpMenu, updateStatus } from '../../src/web/src/components/Dashboard/HelpMenu.js';
import { versionMismatch } from '../../src/core/updates/updates.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const wire = (over: Partial<UpdateWire>): UpdateWire => ({
  running: '2.0.0',
  install: 'desktop',
  latest: '2.0.0',
  checkedAt: null,
  checkError: null,
  desktop: null,
  available: null,
  whatsNew: null,
  ...over,
});
const helpButton = () => container.querySelector<HTMLButtonElement>('.wd-help-btn')!;
const item = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-help-panel button')].find((b) => b.textContent?.startsWith(label));
const panel = () => container.querySelector('.wd-help-panel');

describe('HelpMenu (the top bar)', () => {
  it('one click away: the version, Check for updates with how it went, What’s new, the shortcuts', () => {
    const onCheck = vi.fn();
    const onWhatsNew = vi.fn();
    const onShortcuts = vi.fn();
    act(() =>
      root.render(
        createElement(HelpMenu, { updates: wire({}), onCheck, onWhatsNew, onShortcuts, note: 'You have the newest work (2.0.0).' }),
      ),
    );
    expect(panel()).toBeNull();
    // The version is on the top bar itself.
    expect(helpButton().textContent).toBe('v2.0.0');
    expect(helpButton().getAttribute('aria-label')).toBe('Help: work v2.0.0');
    act(() => helpButton().click());
    expect(container.querySelector('.wd-help-version')!.textContent).toBe('work v2.0.0');
    expect(panel()!.textContent).toContain('You have the newest work (2.0.0).');
    act(() => item('Check for updates')!.click());
    expect(onCheck).toHaveBeenCalled();
    // A check keeps it open, to show how it went; the others close it.
    expect(panel()).not.toBeNull();
    act(() => item("What's new")!.click());
    expect(onWhatsNew).toHaveBeenCalled();
    expect(panel()).toBeNull();
    act(() => helpButton().click());
    act(() => item('Keyboard shortcuts')!.click());
    expect(onShortcuts).toHaveBeenCalled();
  });

  it('an update downloaded: a dot on the button, where it stands, and Restart to update', () => {
    const onRestart = vi.fn();
    act(() => root.render(createElement(HelpMenu, { updates: wire({ available: { version: '2.1.0', how: 'restart' } }), onRestart })));
    expect(helpButton().classList.contains('wd-help-btn-update')).toBe(true);
    expect(helpButton().getAttribute('aria-label')).toBe('Help: work v2.0.0, 2.1.0 is ready to install');
    act(() => helpButton().click());
    expect(container.querySelector('.wd-help-version')!.textContent).toBe('work v2.0.0 · 2.1.0 is ready to install');
    act(() => item('Restart to update')!.click());
    expect(onRestart).toHaveBeenCalled();
  });

  it('downloading: how far, in the status and a bar', () => {
    act(() =>
      root.render(createElement(HelpMenu, { updates: wire({ available: { version: '2.0.3', how: 'downloading', progress: 45 } }) })),
    );
    act(() => helpButton().click());
    expect(container.querySelector('.wd-help-version')!.textContent).toBe('work v2.0.0 · downloading 2.0.3 (45%)');
    expect(panel()!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('45');
  });

  it('downloading with no percentage (a guess): no bar', () => {
    act(() => root.render(createElement(HelpMenu, { updates: wire({ available: { version: '2.0.3', how: 'downloading' } }) })));
    act(() => helpButton().click());
    expect(panel()!.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('while checking, the item says so and waits; Esc and a click elsewhere close it', () => {
    act(() => root.render(createElement(HelpMenu, { updates: wire({}), onCheck: vi.fn(), checking: true })));
    act(() => helpButton().click());
    expect(item('Checking…')!.disabled).toBe(true);
    expect(panel()!.hasAttribute('data-popover')).toBe(true);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(panel()).toBeNull();
    act(() => helpButton().click());
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(panel()).toBeNull();
  });

  it('updateStatus: ready, downloading, out (a command to run), a failed update, else nothing', () => {
    expect(updateStatus(wire({ available: { version: '2.1.0', how: 'restart' } }))).toBe('2.1.0 is ready to install');
    expect(updateStatus(wire({ available: { version: '2.1.0', how: 'downloading' } }))).toBe('downloading 2.1.0');
    expect(updateStatus(wire({ available: { version: '2.1.0', how: 'command', command: 'npm i -g x' } }))).toBe('2.1.0 is out');
    expect(updateStatus(wire({ desktop: { appVersion: '2.0.0', state: 'failed', error: 'no network' } }))).toBe(
      "couldn't update: no network",
    );
    expect(updateStatus(wire({}))).toBeNull();
    expect(updateStatus(null)).toBeNull();
  });

  it("the app and its window's work web on different versions: a warning sign in the pill, and in the menu why and what to do", () => {
    const mismatch = versionMismatch('2.0.10', '2.0.9-dev.17+9913d67');
    act(() => root.render(createElement(HelpMenu, { updates: wire({ running: '2.0.10' }), mismatch })));
    expect(helpButton().querySelector('.wd-help-mismatch')!.textContent).toBe('⚠');
    expect(helpButton().textContent).toBe('⚠v2.0.10');
    expect(helpButton().title).toContain('this window shows work web v2.0.9-dev.17+9913d67');
    expect(helpButton().getAttribute('aria-label')).toBe('Help: work v2.0.10, work web is v2.0.9-dev.17+9913d67');
    act(() => helpButton().click());
    expect(container.querySelector('.wd-help-mismatch-note')!.textContent).toContain('Quit and reopen the app');
  });

  it('no mismatch (the same version, or no app: a browser tab): no sign', () => {
    expect(versionMismatch('2.0.10', '2.0.10')).toBeNull();
    expect(versionMismatch(null, '2.0.10')).toBeNull();
    expect(versionMismatch('2.0.10', undefined)).toBeNull();
    act(() => root.render(createElement(HelpMenu, { updates: wire({}), mismatch: null })));
    expect(helpButton().querySelector('.wd-help-mismatch')).toBeNull();
  });
});
