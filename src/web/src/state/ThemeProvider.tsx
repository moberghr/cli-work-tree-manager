import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { preloadAppearance, setAppTheme, toggleAppTheme, useAppTheme } from './appearance.js';

/**
 * Light / dark for the top bar's button, over the page's appearance store (state/appearance.ts), which owns the theme:
 * what was chosen (config.json in work web, this browser in `wd`), the OS mode under System, and the stamps on <html>
 * the whole SPA re-themes from through the CSS-variable cascade (see tokens.css). Mounted once at the app root, so every
 * view (`wd`, `wd -c`, `work web`) has the button.
 *
 * `theme` is the base drawn: a named theme (Midnight, Dracula, Tokyo Night) is dark, and the button takes it to light.
 */
export type Theme = 'light' | 'dark';

interface ThemeValue {
  theme: Theme;
  /** True when a theme was chosen (anything but System, which follows the OS). */
  explicit: boolean;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeCtx = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Every view asks for the settings once: in work web they answer (a diff or review page keeps its theme in config.json
  // too, and its button saves it there); in `wd` they don't, and the theme stays this browser's.
  useEffect(() => preloadAppearance(), []);
  const { app, choice } = useAppTheme();
  const value = useMemo<ThemeValue>(
    () => ({ theme: app.base, explicit: choice !== 'system', setTheme: setAppTheme, toggle: toggleAppTheme }),
    [app.base, choice],
  );
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

/** Full controls for the toggle UI. Null when no provider is mounted. */
export function useThemeControls(): ThemeValue | null {
  return useContext(ThemeCtx);
}
