import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { AppThemeId } from '../../../core/settings/app-theme.js';
import { preloadAppearance, setAppTheme, useAppTheme } from './appearance.js';

/**
 * The theme menu's controls (ThemeMenu, the top bar's and the review page's), over the page's appearance store
 * (state/appearance.ts), which owns the theme: what was chosen (config.json in work web, this browser in `wd`), the OS
 * mode under System, and the stamps on <html> the whole SPA re-themes from through the CSS-variable cascade (see
 * tokens.css). Mounted once at the app root, so every view (`wd`, `wd -c`, `work web`) has them.
 */
export type Theme = 'light' | 'dark';

interface ThemeValue {
  /** The base drawn: a named theme (Midnight, Dracula, Tokyo Night) is dark. */
  theme: Theme;
  /** What was chosen: `system` follows the OS. */
  choice: AppThemeId;
  /** The theme is a setting (config.json, work web): every app theme can be picked. False in `wd`. */
  setting: boolean;
  setTheme: (id: AppThemeId) => void;
}

const ThemeCtx = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Every view asks for the settings once: in work web they answer (a diff or review page keeps its theme in config.json
  // too, and its menu saves it there); in `wd` they don't, and the theme stays this browser's.
  useEffect(() => preloadAppearance(), []);
  const { app, choice, setting } = useAppTheme();
  const value = useMemo<ThemeValue>(() => ({ theme: app.base, choice, setting, setTheme: setAppTheme }), [app.base, choice, setting]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

/** The controls for the theme menu. Null when no provider is mounted. */
export function useThemeControls(): ThemeValue | null {
  return useContext(ThemeCtx);
}
