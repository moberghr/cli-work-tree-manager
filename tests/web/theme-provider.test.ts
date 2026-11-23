// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<SettingsWire>>(),
  saveSetting: vi.fn<(path: string, value: unknown) => Promise<SettingsWire>>(),
}));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchSettings: () => m.fetchSettings(),
  saveSetting: (path: string, value: unknown) => m.saveSetting(path, value),
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => undefined }));

import { ThemeProvider, useThemeControls } from '../../src/web/src/state/ThemeProvider.js';
import { ThemeMenu } from '../../src/web/src/components/ThemeMenu.js';
import { _resetAppearance, useAppearanceUpdates } from '../../src/web/src/state/appearance.js';

/** The theme menu (the top bar's and the review page's) and its controls: a thin adapter over the appearance store. */

const os = { dark: false, listeners: new Set<(e: MediaQueryListEvent) => void>() };
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    media: query,
    get matches() {
      return os.dark;
    },
    addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => os.listeners.add(fn),
    removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => os.listeners.delete(fn),
  }),
});

const wire = (values: Record<string, unknown>): SettingsWire => ({ values, configPath: '/home/me/.work/config.json' });
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  m.fetchSettings.mockReset();
  // As `wd`'s server answers: no settings. A work web test says otherwise.
  m.fetchSettings.mockRejectedValue(new Error('404 Not Found for /api/settings'));
  m.saveSetting.mockReset();
  m.saveSetting.mockImplementation(async (path, value) => wire({ [path]: value }));
  os.dark = false;
  localStorage.clear();
  _resetAppearance();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

let controls: ReturnType<typeof useThemeControls> = null;
function Probe() {
  controls = useThemeControls();
  return createElement('span', null, controls ? `${controls.theme} ${controls.choice}` : 'none');
}
function WorkWeb() {
  useAppearanceUpdates();
  return null;
}
function render(menu: ReturnType<typeof createElement>, ...children: ReturnType<typeof createElement>[]) {
  act(() => root.render(createElement(ThemeProvider, null, createElement(Probe), menu, ...children)));
}
const shown = () => host.querySelector('span')!.textContent;
const button = () => host.querySelector<HTMLButtonElement>('.wd-theme-btn')!;
const open = () => act(() => button().click());
const items = () => [...document.querySelectorAll<HTMLButtonElement>('.wd-row-menu-item')];
const labels = () => items().map((b) => b.textContent!.replace('✓', ''));
const checked = () =>
  items()
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.textContent!.replace('✓', ''));
const pick = (label: string) =>
  act(() =>
    items()
      .find((b) => b.textContent!.replace('✓', '') === label)!
      .click(),
  );

describe('ThemeMenu', () => {
  it('without a provider there are no controls, and no button', () => {
    act(() => root.render(createElement('div', null, createElement(Probe), createElement(ThemeMenu))));
    expect(shown()).toBe('none');
    expect(host.querySelector('button')).toBeNull();
  });

  it('nothing chosen: System, the OS mode, and it follows the OS; the button says what is on', () => {
    render(createElement(ThemeMenu));
    expect(shown()).toBe('light system');
    expect(button().getAttribute('aria-label')).toBe('Theme: System');
    act(() => {
      os.dark = true;
      for (const l of [...os.listeners]) l({ matches: true } as MediaQueryListEvent);
    });
    expect(shown()).toBe('dark system');
  });

  it("in wd: System, Light and Dark, the one on checked; a pick is this browser's, nothing saved, no Settings", async () => {
    render(createElement(ThemeMenu, { onSettings: () => undefined }));
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1); // asked once; no settings here
    open();
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(labels()).toEqual(['System', 'Light', 'Dark']);
    expect(checked()).toEqual(['System']);
    expect(items()[0]!.getAttribute('role')).toBe('menuitemradio');

    pick('Dark');
    expect(items()).toEqual([]); // a pick closes it
    expect(shown()).toBe('dark dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('wd:theme')).toBe('dark');
    expect(button().getAttribute('aria-label')).toBe('Theme: Dark');
    expect(m.saveSetting).not.toHaveBeenCalled();
  });

  it("in work web, the top bar's: every app theme and More in Settings…; a pick saves the setting", async () => {
    m.fetchSettings.mockResolvedValue(wire({ theme: 'dracula' }));
    const onSettings = vi.fn();
    render(createElement(ThemeMenu, { onSettings }), createElement(WorkWeb));
    await flush();
    expect(document.documentElement.dataset.appTheme).toBe('dracula');
    open();
    expect(labels()).toEqual(['System', 'Light', 'Dark', 'Midnight', 'Dracula', 'Tokyo Night', 'More in Settings…']);
    expect(checked()).toEqual(['Dracula']);

    pick('Tokyo Night');
    expect(m.saveSetting).toHaveBeenCalledWith('theme', 'tokyo-night');
    expect(shown()).toBe('dark tokyo-night');
    expect(document.documentElement.dataset.appTheme).toBe('tokyo-night');
    await flush();

    open();
    pick('More in Settings…');
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('in work web, a page without the dashboard (a diff or review page): every app theme, saved to config.json; no Settings item', async () => {
    m.fetchSettings.mockResolvedValue(wire({ theme: 'midnight' }));
    render(createElement(ThemeMenu));
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.appTheme).toBe('midnight');
    open();
    expect(labels()).toEqual(['System', 'Light', 'Dark', 'Midnight', 'Dracula', 'Tokyo Night']);

    pick('Light');
    expect(m.saveSetting).toHaveBeenCalledWith('theme', 'light');
    await flush();
    expect(localStorage.getItem('wd:theme')).toBe('light');
  });

  it('a click on the button while its menu is open closes it', () => {
    render(createElement(ThemeMenu));
    open();
    expect(items().length).toBe(3);
    act(() => {
      button().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      button().click();
    });
    expect(items()).toEqual([]);
    expect(button().getAttribute('aria-expanded')).toBe('false');
  });
});
