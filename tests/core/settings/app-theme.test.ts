import { describe, expect, it } from 'vitest';
import { APP_THEMES, DEFAULT_APP_THEME, isAppThemeId, resolveAppTheme } from '../../../src/core/settings/app-theme.js';
import { TERMINAL_THEMES } from '../../../src/core/settings/terminal-style.js';

describe('the app themes', () => {
  it('are the five, in order, with unique ids', () => {
    expect(APP_THEMES.map((t) => t.id)).toEqual(['light', 'dark', 'midnight', 'dracula', 'tokyo-night']);
    expect(APP_THEMES.map((t) => t.label)).toEqual(['Light', 'Dark', 'Midnight', 'Dracula', 'Tokyo Night']);
    expect(DEFAULT_APP_THEME).toBe('system');
  });

  it('each maps to a terminal palette that exists', () => {
    const palettes = TERMINAL_THEMES.map((t) => t.id as string);
    for (const t of APP_THEMES) expect(palettes, t.id).toContain(t.terminal);
  });
});

describe('resolveAppTheme', () => {
  it('each named theme gives its own base and terminal palette, whatever the computer does', () => {
    const expected = {
      light: ['light', 'github-light'],
      dark: ['dark', 'default'],
      midnight: ['dark', 'midnight'],
      dracula: ['dark', 'dracula'],
      'tokyo-night': ['dark', 'tokyo-night'],
    } as const;
    for (const t of APP_THEMES)
      for (const osDark of [true, false])
        expect(resolveAppTheme(t.id, osDark), `${t.id} ${osDark}`).toEqual({
          id: t.id,
          base: expected[t.id][0],
          terminal: expected[t.id][1],
        });
  });

  it('system, absent or unknown follows the computer: dark when it is, else light', () => {
    for (const v of ['system', undefined, null, 'solarized', 7, {}, '']) {
      expect(resolveAppTheme(v, true), String(v)).toEqual({ id: 'dark', base: 'dark', terminal: 'default' });
      expect(resolveAppTheme(v, false), String(v)).toEqual({ id: 'light', base: 'light', terminal: 'github-light' });
    }
  });
});

describe('isAppThemeId', () => {
  it('knows system and each theme, nothing else', () => {
    for (const id of ['system', ...APP_THEMES.map((t) => t.id)]) expect(isAppThemeId(id), id).toBe(true);
    for (const v of ['app', 'Dark', '', null, undefined, 3]) expect(isAppThemeId(v), String(v)).toBe(false);
  });
});
