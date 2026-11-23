/**
 * How the whole app is themed: the choices on the Settings page, whether each is a light or a dark page, and the
 * terminal palette it maps to (the terminal follows the app unless it is given a palette of its own). Pure and
 * import-free, because the SPA bundles it and the settings schema's option lists are held equal to it by a test.
 *
 * `system` follows the computer's light or dark mode. Anything unknown is `system`: a bad value never breaks the page.
 */

export type AppThemeId = 'system' | 'light' | 'dark' | 'midnight' | 'dracula' | 'tokyo-night';

/** The themes with a look of their own, in the order the Settings page lists them (`system` comes before them). */
export const APP_THEMES: readonly { id: Exclude<AppThemeId, 'system'>; label: string; base: 'light' | 'dark'; terminal: string }[] = [
  { id: 'light', label: 'Light', base: 'light', terminal: 'github-light' },
  { id: 'dark', label: 'Dark', base: 'dark', terminal: 'default' },
  { id: 'midnight', label: 'Midnight', base: 'dark', terminal: 'midnight' },
  { id: 'dracula', label: 'Dracula', base: 'dark', terminal: 'dracula' },
  { id: 'tokyo-night', label: 'Tokyo Night', base: 'dark', terminal: 'tokyo-night' },
];

export const DEFAULT_APP_THEME: AppThemeId = 'system';

export interface ResolvedAppTheme {
  id: Exclude<AppThemeId, 'system'>;
  base: 'light' | 'dark';
  /** The id of the terminal palette this theme maps to. */
  terminal: string;
}

/** The theme to draw: the one named, or for `system`, absent or unknown, light or dark by the computer's mode. */
export function resolveAppTheme(value: unknown, osDark: boolean): ResolvedAppTheme {
  const theme = APP_THEMES.find((t) => t.id === value) ?? APP_THEMES.find((t) => t.id === (osDark ? 'dark' : 'light'))!;
  return { id: theme.id, base: theme.base, terminal: theme.terminal };
}

export function isAppThemeId(v: unknown): v is AppThemeId {
  return v === 'system' || APP_THEMES.some((t) => t.id === v);
}
