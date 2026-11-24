// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsWire } from '../../src/core/api-types.js';
import { DEFAULT_TERMINAL_STYLE } from '../../src/core/settings/terminal-style.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<SettingsWire>>(),
  saveSetting: vi.fn<(path: string, value: unknown) => Promise<SettingsWire>>(),
  /** One per mounted component, as the pooled stream dispatches an event to each subscriber. */
  subs: new Set<(event: string) => void>(),
}));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchSettings: () => m.fetchSettings(),
  saveSetting: (path: string, value: unknown) => m.saveSetting(path, value),
}));
vi.mock('../../src/web/src/api/events.js', async () => {
  const React = await import('react');
  return {
    useSse: (_url: string | null, handlers: { events?: Record<string, (data: unknown) => void>; onOpen?: () => void }) => {
      const ref = React.useRef(handlers);
      ref.current = handlers;
      React.useEffect(() => {
        // 'open': the stream (re)connected.
        const sub = (event: string) => (event === 'open' ? ref.current.onOpen?.() : ref.current.events?.[event]?.({ ts: Date.now() }));
        m.subs.add(sub);
        return () => void m.subs.delete(sub);
      }, []);
    },
  };
});

import {
  _resetAppearance,
  getAppTheme,
  getTerminalStyle,
  loadAppearance,
  preloadAppearance,
  setAppTheme,
  subscribeAppearance,
  useAppearanceUpdates,
  useTerminalStyle,
} from '../../src/web/src/state/appearance.js';

/** The computer's light or dark mode: a matchMedia whose change can be fired. jsdom has none. */
const os = { dark: true, listeners: new Set<(e: MediaQueryListEvent) => void>() };
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
function setOsDark(dark: boolean) {
  os.dark = dark;
  for (const l of [...os.listeners]) l({ matches: dark } as MediaQueryListEvent);
}
/** A fresh page, with the OS and the browser's cache as given (the store reads both at load). */
function freshPage({ dark = true, cached }: { dark?: boolean; cached?: string } = {}) {
  os.dark = dark;
  localStorage.clear();
  if (cached !== undefined) localStorage.setItem('wd:theme', cached);
  _resetAppearance();
}

const wire = (values: Record<string, unknown>, terminalColors?: Record<string, string>): SettingsWire => ({
  values,
  ...(terminalColors ? { terminalColors } : {}),
  configPath: '/home/me/.work/config.json',
});
const dracula = wire(
  { 'terminal.theme': 'dracula', 'terminal.fontFamily': 'Fira Code', 'terminal.fontSize': 15, 'terminal.lineHeight': 1.3 },
  { background: '#000000' },
);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const html = document.documentElement;
const htmlVar = (name: string) => html.style.getPropertyValue(name);
const cache = () => localStorage.getItem('wd:theme');

beforeEach(() => {
  m.fetchSettings.mockReset();
  m.saveSetting.mockReset();
  // The server answers a save with what config.json then holds.
  m.saveSetting.mockImplementation(async (path, value) => wire({ [path]: value }));
  m.subs.clear();
  // The OS is dark unless a test says otherwise: the terminal then follows to today's palette.
  freshPage();
});

describe('the terminal style store', () => {
  it("is today's look until the settings arrive (dark OS), stamped on <html> as the boot script painted it", () => {
    expect(getTerminalStyle()).toEqual(DEFAULT_TERMINAL_STYLE);
    expect(getTerminalStyle().theme).toMatchObject({ background: '#1e1e1e', foreground: '#d4d4d4' });
    expect(htmlVar('--term-bg')).toBe('#1e1e1e');
    expect(htmlVar('--term-fg')).toBe('#d4d4d4');
    expect(htmlVar('--term-dim')).toBe('#555753');
    expect(htmlVar('--term-error')).toBe('#cc0000');
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.appTheme).toBeUndefined();
  });

  it('a load takes the theme, font, size, line height and hand-written colours, tells subscribers once and sets the colours on <html>', async () => {
    m.fetchSettings.mockResolvedValueOnce(dracula);
    const heard = vi.fn();
    subscribeAppearance(heard);
    await loadAppearance();
    const s = getTerminalStyle();
    expect(s.themeId).toBe('dracula');
    expect(s.theme).toMatchObject({ background: '#000000', foreground: '#f8f8f2', red: '#ff5555' });
    expect(s.fontFamily).toMatch(/^"Fira Code", "Cascadia Code"/);
    expect(s.fontSize).toBe(15);
    expect(s.lineHeight).toBe(1.3);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(htmlVar('--term-bg')).toBe('#000000');
    expect(htmlVar('--term-fg')).toBe('#f8f8f2');
    // Connecting and a failed start take the palette's dim grey and red.
    expect(htmlVar('--term-dim')).toBe('#6272a4');
    expect(htmlVar('--term-error')).toBe('#ff5555');
  });

  it('calls while a read runs make exactly one more read after it, and the last answer wins', async () => {
    const first = deferred<SettingsWire>();
    const second = deferred<SettingsWire>();
    m.fetchSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loads = [loadAppearance(), loadAppearance(), loadAppearance()];
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);

    first.resolve(wire({ 'terminal.fontSize': 14 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(getTerminalStyle().fontSize).toBe(14);

    second.resolve(wire({ 'terminal.fontSize': 20 }));
    await Promise.all(loads);
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(getTerminalStyle().fontSize).toBe(20);

    // Done: the next call reads again.
    m.fetchSettings.mockResolvedValueOnce(wire({ 'terminal.fontSize': 21 }));
    await loadAppearance();
    expect(m.fetchSettings).toHaveBeenCalledTimes(3);
    expect(getTerminalStyle().fontSize).toBe(21);
  });

  it('a failed read keeps the style it has and never rejects', async () => {
    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadAppearance();
    const had = getTerminalStyle();
    const heard = vi.fn();
    subscribeAppearance(heard);

    m.fetchSettings.mockRejectedValueOnce(new Error('500 Internal Server Error for /api/settings'));
    await expect(loadAppearance()).resolves.toBeUndefined();
    expect(getTerminalStyle()).toBe(had);
    expect(heard).not.toHaveBeenCalled();
    expect(htmlVar('--term-bg')).toBe('#000000');
  });

  it('an answer that gives the same style tells nobody (an unrelated setting changed)', async () => {
    const before = getTerminalStyle();
    // The first answer makes the theme a setting (the theme menu hears that); the terminal's style keeps its object.
    m.fetchSettings.mockResolvedValueOnce(wire({}));
    await loadAppearance();
    expect(getAppTheme().setting).toBe(true);
    expect(getTerminalStyle()).toBe(before);
    const heard = vi.fn();
    subscribeAppearance(heard);
    m.fetchSettings.mockResolvedValueOnce(wire({ 'prWatch.fixCi': false }));
    await loadAppearance();
    expect(heard).not.toHaveBeenCalled();
    expect(getTerminalStyle()).toBe(before);

    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadAppearance();
    expect(heard).toHaveBeenCalledTimes(1);
    m.fetchSettings.mockResolvedValueOnce(wire({ ...dracula.values, sleepIdleAfterMinutes: 20 }, dracula.terminalColors));
    await loadAppearance();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("back to nothing set: today's look again, <html> back to its colours, subscribers told once", async () => {
    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadAppearance();
    const heard = vi.fn();
    subscribeAppearance(heard);
    m.fetchSettings.mockResolvedValueOnce(wire({}));
    await loadAppearance();
    expect(getTerminalStyle()).toEqual(DEFAULT_TERMINAL_STYLE);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(htmlVar('--term-bg')).toBe('#1e1e1e');
    expect(htmlVar('--term-fg')).toBe('#d4d4d4');
  });

  it('the page asks once at its start (DashboardApp), however often; after a failed read the next ask reads again', async () => {
    m.fetchSettings.mockRejectedValueOnce(new Error('the server is still starting'));
    preloadAppearance();
    preloadAppearance();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);
    expect(getTerminalStyle()).toEqual(DEFAULT_TERMINAL_STYLE);

    m.fetchSettings.mockResolvedValue(dracula);
    preloadAppearance();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(getTerminalStyle().themeId).toBe('dracula');
    preloadAppearance();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
  });

  it('an unsubscribed listener hears nothing', async () => {
    const heard = vi.fn();
    const off = subscribeAppearance(heard);
    off();
    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadAppearance();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("the app's theme", () => {
  it("a settings read with theme 'dracula' stamps dark + data-app-theme, and the terminal follows (even on a light OS)", async () => {
    freshPage({ dark: false });
    expect(html.dataset.theme).toBe('light');
    expect(getTerminalStyle().themeId).toBe('github-light');

    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'dracula' }));
    await loadAppearance();
    expect(getAppTheme()).toEqual({ app: { id: 'dracula', base: 'dark', terminal: 'dracula' }, choice: 'dracula', setting: true });
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.appTheme).toBe('dracula');
    expect(getTerminalStyle().themeId).toBe('dracula');
    expect(htmlVar('--term-bg')).toBe('#282a36');

    // Back to Light: the named theme's attribute goes, the terminal follows to GitHub Light.
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'light' }));
    await loadAppearance();
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.appTheme).toBeUndefined();
    expect(htmlVar('--term-bg')).toBe('#ffffff');
  });

  it("a terminal palette of its own overrides the app's", async () => {
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'dracula', 'terminal.theme': 'github-light' }));
    await loadAppearance();
    expect(html.dataset.appTheme).toBe('dracula');
    expect(getTerminalStyle().themeId).toBe('github-light');
    expect(htmlVar('--term-bg')).toBe('#ffffff');
  });

  it("under System the OS's change is followed, by the page and by a terminal that matches the app", async () => {
    m.fetchSettings.mockResolvedValueOnce(wire({ 'terminal.theme': 'app' }));
    await loadAppearance();
    expect(getAppTheme().choice).toBe('system');
    expect(getTerminalStyle().themeId).toBe('default');
    const heard = vi.fn();
    subscribeAppearance(heard);

    setOsDark(false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(html.dataset.theme).toBe('light');
    expect(getTerminalStyle().themeId).toBe('github-light');
    expect(htmlVar('--term-bg')).toBe('#ffffff');

    setOsDark(true);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(html.dataset.theme).toBe('dark');
    expect(getTerminalStyle().themeId).toBe('default');
    expect(htmlVar('--term-bg')).toBe('#1e1e1e');

    // A theme chosen: the OS no longer matters.
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'midnight' }));
    await loadAppearance();
    heard.mockClear();
    setOsDark(false);
    expect(heard).not.toHaveBeenCalled();
    expect(html.dataset.appTheme).toBe('midnight');
  });

  it("the browser's cache mirrors config.json, and has no entry for System", async () => {
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'tokyo-night' }));
    await loadAppearance();
    expect(cache()).toBe('tokyo-night');
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'system' }));
    await loadAppearance();
    expect(cache()).toBeNull();
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'light' }));
    await loadAppearance();
    expect(cache()).toBe('light');
    m.fetchSettings.mockResolvedValueOnce(wire({}));
    await loadAppearance();
    expect(cache()).toBeNull();
  });

  it('before the settings arrive the cache paints the page; one that fits no theme is System', () => {
    freshPage({ dark: false, cached: 'midnight' });
    expect(getAppTheme().choice).toBe('midnight');
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.appTheme).toBe('midnight');
    expect(getTerminalStyle().themeId).toBe('midnight');

    freshPage({ dark: false, cached: 'purple' });
    expect(getAppTheme().choice).toBe('system');
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.appTheme).toBeUndefined();
  });

  it("upgrade: once read, an absent theme is System, even with the browser's old 'dark' cached", async () => {
    freshPage({ dark: false, cached: 'dark' });
    expect(html.dataset.theme).toBe('dark');
    m.fetchSettings.mockResolvedValueOnce(wire({}));
    await loadAppearance();
    expect(getAppTheme()).toMatchObject({ choice: 'system', app: { base: 'light' } });
    expect(html.dataset.theme).toBe('light');
    expect(cache()).toBeNull();
  });

  it('another tab changing the cache re-themes this one', () => {
    localStorage.setItem('wd:theme', 'dracula');
    window.dispatchEvent(new StorageEvent('storage', { key: 'wd:theme' }));
    expect(getAppTheme().choice).toBe('dracula');
    expect(html.dataset.appTheme).toBe('dracula');
  });

  it('on a page whose theme is a setting, another tab changing the cache reads config.json again', async () => {
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'light' }));
    await loadAppearance();
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'tokyo-night' }));
    localStorage.setItem('wd:theme', 'tokyo-night');
    window.dispatchEvent(new StorageEvent('storage', { key: 'wd:theme' }));
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(getAppTheme().choice).toBe('tokyo-night');
  });
});

describe('choosing the theme', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function WorkWeb() {
    useAppearanceUpdates();
    return null;
  }

  it('in work web, it is a setting: saved, the page changed at once, the cache once the save is answered', async () => {
    m.fetchSettings.mockResolvedValue(wire({ theme: 'light' }));
    act(() => root.render(createElement(WorkWeb)));
    await flush();
    expect(html.dataset.theme).toBe('light');

    act(() => setAppTheme('dark'));
    expect(m.saveSetting).toHaveBeenCalledWith('theme', 'dark');
    expect(getAppTheme().choice).toBe('dark');
    expect(html.dataset.theme).toBe('dark');
    expect(cache()).toBe('light');
    await flush();
    expect(cache()).toBe('dark');

    act(() => setAppTheme('dracula'));
    expect(m.saveSetting).toHaveBeenLastCalledWith('theme', 'dracula');
    expect(html.dataset.appTheme).toBe('dracula');
    expect(getTerminalStyle().themeId).toBe('dracula');

    // From a named theme back to a base one: its own attribute goes.
    act(() => setAppTheme('light'));
    expect(m.saveSetting).toHaveBeenLastCalledWith('theme', 'light');
    expect(html.dataset.appTheme).toBeUndefined();
    await flush();
  });

  it('in work web, a failed save reads the settings again, so the page shows what is kept', async () => {
    m.fetchSettings.mockResolvedValue(wire({ theme: 'light' }));
    act(() => root.render(createElement(WorkWeb)));
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);

    m.saveSetting.mockRejectedValueOnce(new Error('400 Bad Request'));
    act(() => setAppTheme('midnight'));
    expect(html.dataset.appTheme).toBe('midnight');
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(getAppTheme().choice).toBe('light');
    expect(html.dataset.appTheme).toBeUndefined();
    expect(cache()).toBe('light');
  });

  it("a read that crosses a save doesn't undo the choice; the page settles from the last save's answer", async () => {
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'light' }));
    await loadAppearance();
    const first = deferred<SettingsWire>();
    const second = deferred<SettingsWire>();
    m.saveSetting.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    setAppTheme('dark');
    setAppTheme('dracula'); // a second click before the first is answered

    // The first save's settings-changed read lands before the second is written.
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'dark', 'terminal.fontSize': 16 }));
    await loadAppearance();
    expect(getAppTheme().choice).toBe('dracula');
    expect(getTerminalStyle().fontSize).toBe(16); // the rest of the read is taken
    expect(cache()).toBe('light'); // not mirrored while a save is pending

    first.resolve(wire({ theme: 'dark' }));
    await flush();
    expect(getAppTheme().choice).toBe('dracula');
    second.resolve(wire({ theme: 'dracula' }));
    await flush();
    expect(getAppTheme().choice).toBe('dracula');
    expect(html.dataset.appTheme).toBe('dracula');
    expect(cache()).toBe('dracula');
  });

  it('a page without the dashboard (a diff or review page in work web) keeps its theme in config.json once its settings answer', async () => {
    expect(getAppTheme().setting).toBe(false);
    m.fetchSettings.mockResolvedValueOnce(wire({ theme: 'dark' }));
    await loadAppearance();
    expect(getAppTheme().setting).toBe(true); // the theme menu offers every app theme
    setAppTheme('midnight');
    expect(m.saveSetting).toHaveBeenCalledWith('theme', 'midnight');
    await flush();
    expect(cache()).toBe('midnight');
  });

  it("in wd the settings don't answer (404), so the choice stays this browser's", async () => {
    m.fetchSettings.mockRejectedValueOnce(new Error('404 Not Found for /api/settings'));
    await loadAppearance();
    expect(getAppTheme().setting).toBe(false); // the theme menu offers System, Light and Dark
    setAppTheme('midnight');
    expect(m.saveSetting).not.toHaveBeenCalled();
    expect(cache()).toBe('midnight');
    expect(html.dataset.appTheme).toBe('midnight');
  });

  it('in wd (no settings), this browser remembers it and nothing is saved or read', () => {
    freshPage({ dark: false });
    setAppTheme('midnight');
    expect(cache()).toBe('midnight');
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.appTheme).toBe('midnight');

    setAppTheme('light');
    expect(cache()).toBe('light');
    expect(html.dataset.theme).toBe('light');
    setAppTheme('dark');
    expect(cache()).toBe('dark');

    setAppTheme('system');
    expect(cache()).toBeNull();
    expect(html.dataset.theme).toBe('light');
    expect(m.saveSetting).not.toHaveBeenCalled();
    expect(m.fetchSettings).not.toHaveBeenCalled();
  });
});

describe('useTerminalStyle', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function Probe({ id }: { id: string }) {
    const s = useTerminalStyle();
    return createElement('span', { 'data-id': id }, `${s.themeId} ${s.fontSize}`);
  }
  /** The page (DashboardApp): its one subscription, and its terminals. */
  function Page({ ids }: { ids: string[] }) {
    useAppearanceUpdates();
    return createElement(
      'div',
      null,
      ids.map((id) => createElement(Probe, { id, key: id })),
    );
  }
  const shown = () => [...host.querySelectorAll('span')].map((el) => el.textContent);

  it('two terminals read the settings once on mount; a settings-changed reads once more and both redraw with the new style', async () => {
    m.fetchSettings.mockResolvedValue(dracula);
    act(() => root.render(createElement(Page, { ids: ['a', 'b'] })));
    expect(shown()).toEqual(['default 13', 'default 13']);
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual(['dracula 15', 'dracula 15']);

    m.fetchSettings.mockResolvedValue(wire({ 'terminal.theme': 'tokyo-night', 'terminal.fontSize': 18 }));
    act(() => {
      for (const sub of m.subs) sub('settings-changed');
    });
    await flush();
    // One subscription for the page, whatever the number of terminals: one event, one read.
    expect(m.subs.size).toBe(1);
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual(['tokyo-night 18', 'tokyo-night 18']);
  });

  it('the event stream (re)connecting reads again: a first read that failed, or a change sent while it was down, is not lost', async () => {
    m.fetchSettings.mockRejectedValueOnce(new Error('the server is still starting'));
    act(() => root.render(createElement(Page, { ids: ['a'] })));
    await flush();
    expect(shown()).toEqual(['default 13']);

    m.fetchSettings.mockResolvedValue(dracula);
    act(() => {
      for (const sub of m.subs) sub('open');
    });
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual(['dracula 15']);
  });

  it('a terminal mounted later uses the style already loaded, without reading again', async () => {
    m.fetchSettings.mockResolvedValue(dracula);
    act(() => root.render(createElement(Page, { ids: ['a'] })));
    await flush();
    act(() => root.render(createElement(Page, { ids: ['a', 'b'] })));
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual(['dracula 15', 'dracula 15']);
  });

  it('a terminal that matches the app redraws when the app theme changes', async () => {
    m.fetchSettings.mockResolvedValue(wire({ theme: 'tokyo-night' }));
    act(() => root.render(createElement(Page, { ids: ['a'] })));
    await flush();
    expect(shown()).toEqual(['tokyo-night 13']);
    act(() => setAppTheme('light'));
    expect(shown()).toEqual(['github-light 13']);
    await flush();
  });
});
