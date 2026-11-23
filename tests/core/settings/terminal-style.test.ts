import { describe, expect, it } from 'vitest';
import {
  checkTerminalColors,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_STYLE,
  resolveTerminalStyle,
  TERMINAL_COLOR_KEYS,
  TERMINAL_THEME_APP,
  TERMINAL_THEMES,
} from '../../../src/core/settings/terminal-style.js';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const defaultTheme = TERMINAL_THEMES[0]!;

describe('the terminal themes', () => {
  it('every theme has all 21 colours, each a hex colour, and the ids are unique', () => {
    expect(TERMINAL_COLOR_KEYS.length).toBe(21);
    expect(new Set(TERMINAL_THEMES.map((t) => t.id)).size).toBe(TERMINAL_THEMES.length);
    for (const t of TERMINAL_THEMES) {
      expect(Object.keys(t.palette), t.id).toEqual([...TERMINAL_COLOR_KEYS]);
      for (const k of TERMINAL_COLOR_KEYS) expect(t.palette[k], `${t.id}.${k}`).toMatch(HEX);
    }
  });

  it('Default dark is today’s look: xterm’s own defaults', () => {
    expect(defaultTheme.id).toBe('default');
    expect(defaultTheme.palette).toMatchObject({
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#ffffff',
      cursorAccent: '#000000',
      selectionBackground: '#ffffff4d',
      black: '#2e3436',
      red: '#cc0000',
      green: '#4e9a06',
      yellow: '#c4a000',
      blue: '#3465a4',
      magenta: '#75507b',
      cyan: '#06989a',
      white: '#d3d7cf',
      brightBlack: '#555753',
      brightRed: '#ef2929',
      brightGreen: '#8ae234',
      brightYellow: '#fce94f',
      brightBlue: '#729fcf',
      brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2',
      brightWhite: '#eeeeec',
    });
  });
});

describe('resolveTerminalStyle', () => {
  it('nothing set: the default theme, the default stack, 13 and 1', () => {
    const s = resolveTerminalStyle({});
    expect(s).toEqual(DEFAULT_TERMINAL_STYLE);
    expect(s.themeId).toBe('default');
    expect(s.theme).toEqual(defaultTheme.palette);
    expect(s.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(s.fontSize).toBe(13);
    expect(s.lineHeight).toBe(1);
  });

  it('a theme by its id; an unknown one is the default when nothing is followed', () => {
    expect(resolveTerminalStyle({ 'terminal.theme': 'dracula' }).theme.background).toBe('#282a36');
    expect(resolveTerminalStyle({ 'terminal.theme': 'dracula' }).themeId).toBe('dracula');
    expect(resolveTerminalStyle({ 'terminal.theme': 'solarized' }).themeId).toBe('default');
    expect(resolveTerminalStyle({ 'terminal.theme': 7 }).theme).toEqual(defaultTheme.palette);
  });

  it('without a palette of its own the terminal follows: absent, app and unknown take the follow palette', () => {
    for (const values of [{}, { 'terminal.theme': 'app' }, { 'terminal.theme': 'solarized' }, { 'terminal.theme': 7 }]) {
      const s = resolveTerminalStyle(values, undefined, 'dracula');
      expect(s.themeId, JSON.stringify(values)).toBe('dracula');
      expect(s.theme.background).toBe('#282a36');
    }
    expect(resolveTerminalStyle({ 'terminal.theme': TERMINAL_THEME_APP }, undefined, 'github-light').themeId).toBe('github-light');
  });

  it('a palette id overrides the follow palette; an unknown follow is the default palette', () => {
    expect(resolveTerminalStyle({ 'terminal.theme': 'midnight' }, undefined, 'dracula').themeId).toBe('midnight');
    expect(resolveTerminalStyle({ 'terminal.theme': 'app' }, undefined, 'nope').themeId).toBe('default');
    expect(resolveTerminalStyle({}, undefined, 'nope').theme).toEqual(defaultTheme.palette);
  });

  it('hand-written colours still sit over the followed palette', () => {
    const s = resolveTerminalStyle({}, { background: '#000' }, 'dracula');
    expect(s.theme.background).toBe('#000');
    expect(s.theme.foreground).toBe('#f8f8f2');
  });

  it('a valid font comes first, today’s stack after it; a bad one is the stack alone', () => {
    expect(resolveTerminalStyle({ 'terminal.fontFamily': ' Hack, JetBrains Mono ' }).fontFamily).toBe(
      `"Hack", "JetBrains Mono", ${DEFAULT_TERMINAL_FONT_FAMILY}`,
    );
    for (const bad of ['Hack; color: red', 'Hack {', 'a<b', 'a\\b', '', '   ', '"', ' , ,', 12, null])
      expect(resolveTerminalStyle({ 'terminal.fontFamily': bad }).fontFamily, String(bad)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it('a stray quote or comma never voids the list (it would take today’s stack with it); a generic family stays bare', () => {
    const font = (v: string) => resolveTerminalStyle({ 'terminal.fontFamily': v }).fontFamily;
    expect(font('"Hack')).toBe(`"Hack", ${DEFAULT_TERMINAL_FONT_FAMILY}`);
    expect(font('Hack",')).toBe(`"Hack", ${DEFAULT_TERMINAL_FONT_FAMILY}`);
    expect(font(`'JetBrains Mono', Monospace`)).toBe(`"JetBrains Mono", monospace, ${DEFAULT_TERMINAL_FONT_FAMILY}`);
  });

  it('a size or line height out of range or not a number is its default, each on its own', () => {
    expect(resolveTerminalStyle({ 'terminal.fontSize': 16, 'terminal.lineHeight': 1.2 })).toMatchObject({ fontSize: 16, lineHeight: 1.2 });
    expect(resolveTerminalStyle({ 'terminal.fontSize': 40, 'terminal.lineHeight': 1.2 })).toMatchObject({ fontSize: 13, lineHeight: 1.2 });
    expect(resolveTerminalStyle({ 'terminal.fontSize': 16, 'terminal.lineHeight': 3 })).toMatchObject({ fontSize: 16, lineHeight: 1 });
    expect(resolveTerminalStyle({ 'terminal.fontSize': 7, 'terminal.lineHeight': 0.5 })).toMatchObject({ fontSize: 13, lineHeight: 1 });
    for (const bad of ['16', NaN, Infinity, null, {}])
      expect(resolveTerminalStyle({ 'terminal.fontSize': bad, 'terminal.lineHeight': bad })).toMatchObject({ fontSize: 13, lineHeight: 1 });
    expect(resolveTerminalStyle({ 'terminal.fontSize': 8, 'terminal.lineHeight': 2 })).toMatchObject({ fontSize: 8, lineHeight: 2 });
    expect(resolveTerminalStyle({ 'terminal.fontSize': 32, 'terminal.lineHeight': 1 })).toMatchObject({ fontSize: 32, lineHeight: 1 });
  });

  it('a bad field keeps the other fields’ valid values', () => {
    const s = resolveTerminalStyle({
      'terminal.theme': 'midnight',
      'terminal.fontFamily': 'a;b',
      'terminal.fontSize': 'big',
      'terminal.lineHeight': 1.5,
    });
    expect(s).toMatchObject({ themeId: 'midnight', fontFamily: DEFAULT_TERMINAL_FONT_FAMILY, fontSize: 13, lineHeight: 1.5 });
  });

  it('colours override the theme for known keys with 3 or 6 digit hex; 8 (alpha) for the selection only', () => {
    const s = resolveTerminalStyle(
      { 'terminal.theme': 'dracula' },
      { background: '#000', red: '#ff0000', selectionBackground: '#00ff0080', cursor: '#00ff0080' },
    );
    expect(s.theme.background).toBe('#000');
    expect(s.theme.red).toBe('#ff0000');
    expect(s.theme.selectionBackground).toBe('#00ff0080');
    expect(s.theme.cursor).toBe('#f8f8f2');
    expect(s.theme.foreground).toBe('#f8f8f2');
    expect(checkTerminalColors({ background: '#10101480' })).toEqual({});
  });

  it('colours that do not fit are dropped: unknown keys, non-hex values, anything but an object', () => {
    const bad = { nope: '#fff', red: 'red', green: '#12', blue: 5, yellow: '#ggg', cyan: '#12345' } as never;
    expect(resolveTerminalStyle({}, bad).theme).toEqual(defaultTheme.palette);
    for (const notObject of ['#fff', 7, null, ['#fff'], true])
      expect(resolveTerminalStyle({}, notObject as never).theme).toEqual(defaultTheme.palette);
  });

  it('never changes the theme table', () => {
    const before = JSON.stringify(TERMINAL_THEMES);
    const s = resolveTerminalStyle({}, { background: '#123456' });
    expect(s.theme).not.toBe(defaultTheme.palette);
    s.theme.background = '#abcdef';
    expect(JSON.stringify(TERMINAL_THEMES)).toBe(before);
    expect(resolveTerminalStyle({}).theme.background).toBe('#1e1e1e');
  });
});

describe('checkTerminalColors', () => {
  it('keeps only known keys with hex values', () => {
    expect(
      checkTerminalColors({ background: '#abc', red: '#ff0000', selectionBackground: '#ff000080', bogus: '#fff', green: 'green', blue: 1 }),
    ).toEqual({
      background: '#abc',
      red: '#ff0000',
      selectionBackground: '#ff000080',
    });
  });

  it('is empty for what is not an object', () => {
    for (const v of [undefined, null, 'x', 3, ['#fff']]) expect(checkTerminalColors(v)).toEqual({});
  });
});
