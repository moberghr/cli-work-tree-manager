// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsWire } from '../../src/core/api-types.js';
import { DEFAULT_TERMINAL_STYLE } from '../../src/core/settings/terminal-style.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<SettingsWire>>(),
  /** One per mounted component, as the pooled stream dispatches an event to each subscriber. */
  subs: new Set<(event: string) => void>(),
}));
vi.mock('../../src/web/src/api/panes.js', () => ({ fetchSettings: () => m.fetchSettings() }));
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
  _resetTerminalStyle,
  getTerminalStyle,
  loadTerminalStyle,
  preloadTerminalStyle,
  subscribeTerminalStyle,
  useTerminalStyle,
  useTerminalStyleUpdates,
} from '../../src/web/src/state/terminal-style.js';

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
const htmlVar = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  _resetTerminalStyle();
  m.fetchSettings.mockReset();
  m.subs.clear();
});

describe('the terminal style store', () => {
  it("is today's look until the settings arrive, and sets nothing on <html> (tokens.css has the defaults)", () => {
    expect(getTerminalStyle()).toBe(DEFAULT_TERMINAL_STYLE);
    expect(getTerminalStyle().theme).toMatchObject({ background: '#1e1e1e', foreground: '#d4d4d4' });
    expect(htmlVar('--term-bg')).toBe('');
    expect(htmlVar('--term-fg')).toBe('');
  });

  it('a load takes the theme, font, size, line height and hand-written colours, tells subscribers once and sets the two colours on <html>', async () => {
    m.fetchSettings.mockResolvedValueOnce(dracula);
    const heard = vi.fn();
    subscribeTerminalStyle(heard);
    await loadTerminalStyle();
    const s = getTerminalStyle();
    expect(s.themeId).toBe('dracula');
    expect(s.theme).toMatchObject({ background: '#000000', foreground: '#f8f8f2', red: '#ff5555' });
    expect(s.fontFamily).toMatch(/^"Fira Code", "Cascadia Code"/);
    expect(s.fontSize).toBe(15);
    expect(s.lineHeight).toBe(1.3);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(htmlVar('--term-bg')).toBe('#000000');
    expect(htmlVar('--term-fg')).toBe('#f8f8f2');
  });

  it('calls while a read runs make exactly one more read after it, and the last answer wins', async () => {
    const first = deferred<SettingsWire>();
    const second = deferred<SettingsWire>();
    m.fetchSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loads = [loadTerminalStyle(), loadTerminalStyle(), loadTerminalStyle()];
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
    await loadTerminalStyle();
    expect(m.fetchSettings).toHaveBeenCalledTimes(3);
    expect(getTerminalStyle().fontSize).toBe(21);
  });

  it('a failed read keeps the style it has and never rejects', async () => {
    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadTerminalStyle();
    const had = getTerminalStyle();
    const heard = vi.fn();
    subscribeTerminalStyle(heard);

    m.fetchSettings.mockRejectedValueOnce(new Error('500 Internal Server Error for /api/settings'));
    await expect(loadTerminalStyle()).resolves.toBeUndefined();
    expect(getTerminalStyle()).toBe(had);
    expect(heard).not.toHaveBeenCalled();
    expect(htmlVar('--term-bg')).toBe('#000000');
  });

  it('an answer that gives the same style tells nobody (an unrelated setting changed)', async () => {
    const heard = vi.fn();
    subscribeTerminalStyle(heard);
    m.fetchSettings.mockResolvedValueOnce(wire({ 'prWatch.fixCi': false }));
    await loadTerminalStyle();
    expect(heard).not.toHaveBeenCalled();
    expect(getTerminalStyle()).toBe(DEFAULT_TERMINAL_STYLE);

    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadTerminalStyle();
    expect(heard).toHaveBeenCalledTimes(1);
    m.fetchSettings.mockResolvedValueOnce(wire({ ...dracula.values, sleepIdleAfterMinutes: 20 }, dracula.terminalColors));
    await loadTerminalStyle();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("back to nothing set: today's look again, <html> back to its colours, subscribers told once", async () => {
    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadTerminalStyle();
    const heard = vi.fn();
    subscribeTerminalStyle(heard);
    m.fetchSettings.mockResolvedValueOnce(wire({}));
    await loadTerminalStyle();
    expect(getTerminalStyle()).toEqual(DEFAULT_TERMINAL_STYLE);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(htmlVar('--term-bg')).toBe('#1e1e1e');
    expect(htmlVar('--term-fg')).toBe('#d4d4d4');
  });

  it('the page asks once at its start (DashboardApp), however often; after a failed read the next ask reads again', async () => {
    m.fetchSettings.mockRejectedValueOnce(new Error('the server is still starting'));
    preloadTerminalStyle();
    preloadTerminalStyle();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(1);
    expect(getTerminalStyle()).toBe(DEFAULT_TERMINAL_STYLE);

    m.fetchSettings.mockResolvedValue(dracula);
    preloadTerminalStyle();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
    expect(getTerminalStyle().themeId).toBe('dracula');
    preloadTerminalStyle();
    await flush();
    expect(m.fetchSettings).toHaveBeenCalledTimes(2);
  });

  it('an unsubscribed listener hears nothing', async () => {
    const heard = vi.fn();
    const off = subscribeTerminalStyle(heard);
    off();
    m.fetchSettings.mockResolvedValueOnce(dracula);
    await loadTerminalStyle();
    expect(heard).not.toHaveBeenCalled();
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
    useTerminalStyleUpdates();
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
});
