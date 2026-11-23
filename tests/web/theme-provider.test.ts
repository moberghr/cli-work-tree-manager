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
import { ThemeToggle } from '../../src/web/src/components/ThemeToggle.js';
import { _resetAppearance, useAppearanceUpdates } from '../../src/web/src/state/appearance.js';

/** The top bar's light/dark button and its controls: a thin adapter over the appearance store. */

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
  return createElement('span', null, controls ? `${controls.theme} ${controls.explicit ? 'explicit' : 'system'}` : 'none');
}
function WorkWeb() {
  useAppearanceUpdates();
  return null;
}
function render(...children: ReturnType<typeof createElement>[]) {
  act(() => root.render(createElement(ThemeProvider, null, createElement(Probe), createElement(ThemeToggle), ...children)));
}
const shown = () => host.querySelector('span')!.textContent;
const button = () => host.querySelector('button')!;
const click = () => act(() => button().click());

describe('ThemeProvider', () => {
  it('without a provider there are no controls, and no button', () => {
    act(() => root.render(createElement('div', null, createElement(Probe), createElement(ThemeToggle))));
    expect(shown()).toBe('none');
    expect(host.querySelector('button')).toBeNull();
  });

  it('nothing chosen: the OS mode, not explicit, and it follows the OS', () => {
    render();
    expect(shown()).toBe('light system');
    expect(button().getAttribute('aria-label')).toBe('Switch to dark theme');
    act(() => {
      os.dark = true;
      for (const l of [...os.listeners]) l({ matches: true } as MediaQueryListEvent);
    });
    expect(shown()).toBe('dark system');
    expect(button().getAttribute('aria-label')).toBe('Switch to light theme');
  });

  it('in wd, the button flips light and dark through the store, and this browser remembers it', async () => {
    render();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1); // asked once; no settings here
    click();
    expect(shown()).toBe('dark explicit');
    expect(button().getAttribute('aria-label')).toBe('Switch to light theme');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('wd:theme')).toBe('dark');
    click();
    expect(shown()).toBe('light explicit');
    expect(localStorage.getItem('wd:theme')).toBe('light');

    act(() => controls!.setTheme('dark'));
    expect(shown()).toBe('dark explicit');
    expect(m.saveSetting).not.toHaveBeenCalled();
  });

  it('in work web, a named theme is dark; the button takes it to light and saves the setting', async () => {
    m.fetchSettings.mockResolvedValue(wire({ theme: 'dracula' }));
    render(createElement(WorkWeb));
    await flush();
    expect(shown()).toBe('dark explicit');
    expect(document.documentElement.dataset.appTheme).toBe('dracula');
    expect(button().getAttribute('aria-label')).toBe('Switch to light theme');

    click();
    expect(m.saveSetting).toHaveBeenCalledWith('theme', 'light');
    expect(shown()).toBe('light explicit');
    expect(document.documentElement.dataset.appTheme).toBeUndefined();
    await flush();
  });

  it('in work web, a page without the dashboard (a diff or review page) takes config.json and its button saves there', async () => {
    m.fetchSettings.mockResolvedValue(wire({ theme: 'midnight' }));
    render();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.appTheme).toBe('midnight');

    click();
    expect(m.saveSetting).toHaveBeenCalledWith('theme', 'light');
    await flush();
    expect(localStorage.getItem('wd:theme')).toBe('light');
  });
});
