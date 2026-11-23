import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_TERMINAL_STYLE, resolveTerminalStyle, type TerminalStyle } from '../../../core/settings/terminal-style.js';
import { fetchSettings } from '../api/panes.js';
import { useSse } from '../api/events.js';

/**
 * The one style every terminal on the page draws with (Settings → Terminal), kept outside any component: five terminals
 * in the deck read the settings once, not five times, and all of them restyle together when a setting is saved.
 *
 * Until the settings arrive it is today's look (the defaults), so nothing flashes for anyone who never set anything. It
 * also sets `--term-bg` / `--term-fg` on `<html>`, so what the stylesheets paint around a terminal (its padding, the
 * "Connecting…" cover, the deck's slot) has the terminal's own colours.
 */

let style: TerminalStyle = DEFAULT_TERMINAL_STYLE;
const listeners = new Set<() => void>();
// This page has asked for the style (at its start: DashboardApp), and no read has failed since — after one, the next
// terminal to mount asks again.
let requested = false;
// A read is running (`current` ends when it and the one more asked for meanwhile, `again`, are done).
let reading = false;
let current: Promise<void> = Promise.resolve();
let again = false;

const sameStyle = (a: TerminalStyle, b: TerminalStyle) => JSON.stringify(a) === JSON.stringify(b);

function setStyle(next: TerminalStyle): void {
  // An unrelated setting changed: the same style, and no terminal refits for it.
  if (sameStyle(next, style)) return;
  style = next;
  const root = document.documentElement.style;
  root.setProperty('--term-bg', next.theme.background);
  root.setProperty('--term-fg', next.theme.foreground);
  for (const l of listeners) l();
}

/**
 * Read the settings and take the style they give. One read at a time: a call while one runs reads once more after it
 * (whatever the number of calls), so a `settings-changed` that lands meanwhile isn't lost to the older answer.
 */
export function loadTerminalStyle(): Promise<void> {
  if (reading) {
    again = true;
    return current;
  }
  reading = true;
  current = readUntilCurrent();
  return current;
}

async function readUntilCurrent(): Promise<void> {
  try {
    do {
      again = false;
      // A display preference: a failed read keeps the style the terminals have (the Settings page shows the error).
      const wire = await fetchSettings().catch(() => null);
      if (wire) setStyle(resolveTerminalStyle(wire.values, wire.terminalColors));
      requested = !!wire;
    } while (again);
  } finally {
    // In the same step as the last `again` check: no call can land between the two and be lost.
    reading = false;
  }
}

export function getTerminalStyle(): TerminalStyle {
  return style;
}

export function subscribeTerminalStyle(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Ask for the style once for the page; after a failed read, the next call asks again. */
export function preloadTerminalStyle(): void {
  if (requested) return;
  requested = true;
  void loadTerminalStyle();
}

/**
 * The page's one subscription (DashboardApp; one per terminal would read twice per change). The style is read at the
 * page's start, so it is in before a terminal's first replay and the terminal is fitted once, at the user's size, not at
 * today's and then again; read again whenever a setting is saved, and when the event stream (re)connects: a
 * `settings-changed` sent while it was down, or a first read that failed while the server was starting, isn't lost.
 */
export function useTerminalStyleUpdates(): void {
  useEffect(() => preloadTerminalStyle(), []);
  useSse('/events', { events: { 'settings-changed': () => void loadTerminalStyle() }, onOpen: () => void loadTerminalStyle() });
}

/** The style to draw with. A first read that failed is asked again by the next terminal to mount. */
export function useTerminalStyle(): TerminalStyle {
  useEffect(() => preloadTerminalStyle(), []);
  return useSyncExternalStore(subscribeTerminalStyle, getTerminalStyle);
}

/** Test hook: back to the defaults, as on a fresh page. */
export function _resetTerminalStyle(): void {
  style = DEFAULT_TERMINAL_STYLE;
  requested = false;
  reading = false;
  current = Promise.resolve();
  again = false;
  listeners.clear();
  document.documentElement.style.removeProperty('--term-bg');
  document.documentElement.style.removeProperty('--term-fg');
}
