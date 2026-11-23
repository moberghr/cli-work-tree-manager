import { useEffect, useSyncExternalStore } from 'react';
import { isAppThemeId, resolveAppTheme, type AppThemeId, type ResolvedAppTheme } from '../../../core/settings/app-theme.js';
import { resolveTerminalStyle, type TerminalStyle } from '../../../core/settings/terminal-style.js';
import type { SettingsWire } from '../../../core/api-types.js';
import { fetchSettings, saveSetting } from '../api/panes.js';
import { useSse } from '../api/events.js';

/**
 * How the page looks: the app's theme (Settings → Theme, or the top bar's button) and the one style every terminal on
 * the page draws with, kept outside any component. Five terminals in the deck read the settings once, not five times,
 * and the whole page restyles together when a setting is saved.
 *
 * What it knows: the settings' values once the page has read them (work web; `wd` never has them), the browser's cache
 * of the app theme (localStorage `wd:theme`) and the computer's light or dark mode. In work web config.json wins once it
 * is read (absent is System); until then, and always in `wd`, the cache does. The terminal takes the palette the app's
 * theme maps to unless it is given one of its own.
 *
 * It stamps the result on `<html>`: `data-theme` (the light or dark base, for every stylesheet), `data-app-theme` (a
 * named theme's own colours in tokens.css) and `--term-bg` / `--term-fg` (what the stylesheets paint around a terminal:
 * its padding, the "Connecting…" cover, the deck's slot). The boot script in index.html paints the same from the cache
 * before the first frame, so nothing flashes; in work web the cache mirrors config.json for the next load.
 */

const STORAGE_KEY = 'wd:theme';
const OS_DARK = '(prefers-color-scheme: dark)';

export interface AppThemeState {
  /** The theme drawn (never `system`). */
  app: ResolvedAppTheme;
  /** What was chosen: `system` follows the computer. */
  choice: AppThemeId;
}

// The last settings read (null until the page has them).
let values: Record<string, unknown> | null = null;
let colors: Record<string, string> | null = null;
// This page keeps its theme in config.json: its settings answered (work web, the dashboard and its diff and review pages
// alike; `wd` has none, its server says 404).
let fromSettings = false;
// Saves of the theme not answered yet, and the latest one's choice: a read that crosses them may predate them, so the
// theme chosen stands until the last is answered, and the page settles from that answer (what config.json now holds).
let saving = 0;
let savingTheme: AppThemeId = 'system';
// The browser's cache of the app theme; null when it has none (or none that fits).
let cached: AppThemeId | null = null;
let osDark = false;
let media: MediaQueryList | null = null;

let appState: AppThemeState = { app: resolveAppTheme('system', false), choice: 'system' };
let terminal: TerminalStyle = resolveTerminalStyle({});
const listeners = new Set<() => void>();

// This page has asked for the settings (at its start: DashboardApp), and no read has failed since — after one, the next
// terminal to mount asks again.
let requested = false;
// A read is running (`current` ends when it and the one more asked for meanwhile, `again`, are done).
let reading = false;
let current: Promise<void> = Promise.resolve();
let again = false;

function readCache(): AppThemeId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isAppThemeId(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember the theme for the next load's boot script; System is no entry (the boot script follows the OS). */
function writeCache(choice: AppThemeId): void {
  cached = choice === 'system' ? null : choice;
  try {
    if (cached) localStorage.setItem(STORAGE_KEY, cached);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode / quota: the choice just isn't remembered by this browser */
  }
}

function onOsChange(e: MediaQueryListEvent): void {
  osDark = e.matches;
  recompute();
}

/** Read the cache and the OS mode, and follow the OS from now on. At load, and again from the test hook. */
function init(): void {
  cached = readCache();
  media?.removeEventListener('change', onOsChange);
  media = null;
  osDark = false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  try {
    media = window.matchMedia(OS_DARK);
    osDark = media.matches;
    media.addEventListener('change', onOsChange);
  } catch {
    media = null;
  }
}

function stamp(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = appState.app.base;
  // Light and Dark are their base; a named theme has its own block in tokens.css on top of the dark one.
  if (appState.app.id === appState.app.base) delete root.dataset.appTheme;
  else root.dataset.appTheme = appState.app.id;
  root.style.setProperty('--term-bg', terminal.theme.background);
  root.style.setProperty('--term-fg', terminal.theme.foreground);
  // What the page writes over a terminal ("Connecting…", a failed start) takes its dim grey and its red from the palette.
  root.style.setProperty('--term-dim', terminal.theme.brightBlack);
  root.style.setProperty('--term-error', terminal.theme.red);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Derive the theme and the terminal's style from what the page knows. A part that comes out the same keeps its object
 * (so `useSyncExternalStore` sees no change, and no terminal refits for an unrelated setting); only a real change is
 * stamped on `<html>` and told to the subscribers.
 */
function recompute(force = false): void {
  const choice: AppThemeId = values ? (isAppThemeId(values.theme) ? values.theme : 'system') : (cached ?? 'system');
  const nextApp: AppThemeState = { app: resolveAppTheme(choice, osDark), choice };
  const nextTerminal = resolveTerminalStyle(values ?? {}, colors ?? undefined, nextApp.app.terminal);
  const appChanged = !same(nextApp, appState);
  const terminalChanged = !same(nextTerminal, terminal);
  if (appChanged) appState = nextApp;
  if (terminalChanged) terminal = nextTerminal;
  if (!appChanged && !terminalChanged && !force) return;
  stamp();
  for (const l of listeners) l();
}

/**
 * Read the settings and take the look they give. One read at a time: a call while one runs reads once more after it
 * (whatever the number of calls), so a `settings-changed` that lands meanwhile isn't lost to the older answer.
 */
export function loadAppearance(): Promise<void> {
  if (reading) {
    again = true;
    return current;
  }
  reading = true;
  current = readUntilCurrent();
  return current;
}

/** Take the settings config.json holds (a read's, or a save's answer); the cache mirrors them once no save is pending. */
function take(wire: SettingsWire): void {
  fromSettings = true;
  values = saving > 0 ? { ...wire.values, theme: savingTheme } : wire.values;
  colors = wire.terminalColors ?? null;
  recompute();
  if (saving === 0) writeCache(appState.choice);
}

async function readUntilCurrent(): Promise<void> {
  try {
    do {
      again = false;
      // A display preference: a failed read keeps the look the page has (the Settings page shows the error).
      const wire = await fetchSettings().catch(() => null);
      if (wire) take(wire);
      requested = !!wire;
    } while (again);
  } finally {
    // In the same step as the last `again` check: no call can land between the two and be lost.
    reading = false;
  }
}

export function getTerminalStyle(): TerminalStyle {
  return terminal;
}

export function getAppTheme(): AppThemeState {
  return appState;
}

export function subscribeAppearance(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Ask for the settings once for the page; after a failed read, the next call asks again. */
export function preloadAppearance(): void {
  if (requested) return;
  requested = true;
  void loadAppearance();
}

/**
 * Choose the app's theme. In work web it is a setting: the page changes at once and config.json is written; the page
 * settles from the save's answer (the cache with it, so another tab reads config.json only once it holds the choice),
 * and a failed save reads the settings again, so the page shows what is really kept. In `wd`, which has no settings,
 * this browser remembers it.
 */
export function setAppTheme(id: AppThemeId): void {
  if (fromSettings) {
    values = { ...(values ?? {}), theme: id };
    saving++;
    savingTheme = id;
    recompute();
    saveSetting('theme', id).then(
      (wire) => {
        saving--;
        if (saving === 0) take(wire);
      },
      () => {
        saving--;
        void loadAppearance();
      },
    );
    return;
  }
  writeCache(id);
  recompute();
}

/** The top bar's button: light ↔ dark from the base drawn now (a named theme is dark, so it goes light). */
export function toggleAppTheme(): void {
  setAppTheme(appState.app.base === 'dark' ? 'light' : 'dark');
}

/**
 * The page's one subscription (DashboardApp; one per terminal would read twice per change). It marks the page as one
 * whose theme is a setting before any read answers. The settings are read at the page's start, so they are in before a terminal's first replay
 * and the terminal is fitted once, at the user's size, not at today's and then again; read again whenever a setting is
 * saved, and when the event stream (re)connects: a `settings-changed` sent while it was down, or a first read that
 * failed while the server was starting, isn't lost.
 */
export function useAppearanceUpdates(): void {
  useEffect(() => {
    fromSettings = true;
    preloadAppearance();
  }, []);
  useSse('/events', { events: { 'settings-changed': () => void loadAppearance() }, onOpen: () => void loadAppearance() });
}

/** The style to draw with. A first read that failed is asked again by the next terminal to mount. */
export function useTerminalStyle(): TerminalStyle {
  useEffect(() => preloadAppearance(), []);
  return useSyncExternalStore(subscribeAppearance, getTerminalStyle);
}

/** The app's theme drawn now, and what was chosen. */
export function useAppTheme(): AppThemeState {
  return useSyncExternalStore(subscribeAppearance, getAppTheme);
}

// Another tab changed the cached theme (the `storage` event only fires in OTHER documents, and only on a real change,
// so no loop). A page whose theme is a setting asks config.json (a diff page has no event stream to hear the save on);
// in `wd` the cache is the choice.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    if (fromSettings) {
      void loadAppearance();
      return;
    }
    cached = readCache();
    recompute();
  });
}

init();
recompute(true);

/** Test hook: a fresh page — nothing read, the cache and the OS mode read again, and `<html>` stamped from them. */
export function _resetAppearance(): void {
  values = null;
  colors = null;
  fromSettings = false;
  saving = 0;
  savingTheme = 'system';
  requested = false;
  reading = false;
  current = Promise.resolve();
  again = false;
  listeners.clear();
  init();
  recompute(true);
}
