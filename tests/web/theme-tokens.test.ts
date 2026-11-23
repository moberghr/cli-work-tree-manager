import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMINAL_THEMES } from '../../src/core/settings/terminal-style.js';

/** tokens.css as text: each theme's block, its custom properties by name. */
const css = fs.readFileSync(path.join(__dirname, '../../src/web/src/styles/tokens.css'), 'utf8');

const block = (selector: string): Record<string, string> => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf('}', at));
  const props: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) props[m[1]!] = m[2]!.trim();
  return props;
};

const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const dark = block(":root[data-theme='dark']");
const named = ['midnight', 'dracula', 'tokyo-night'] as const;
const palette = (id: string) => TERMINAL_THEMES.find((t) => t.id === id)!.palette;
const READABLE = ['--fg', '--muted', '--accent', '--add-fg', '--del-fg', '--warn-fg', '--claude-fg', '--review-fg', '--background-fg'];

describe('tokens.css themes', () => {
  it.each(named)('%s defines every property the dark block defines', (id) => {
    const props = block(`:root[data-app-theme='${id}']`);
    expect(Object.keys(dark).length).toBeGreaterThan(20);
    for (const name of Object.keys(dark)) expect(props[name], `${id} ${name}`).toBeDefined();
  });

  it.each(named)('%s reads at 4.5:1 or better on its background', (id) => {
    const props = block(`:root[data-app-theme='${id}']`);
    for (const name of READABLE) expect(contrast(props[name]!, props['--bg']!), `${id} ${name}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(named)("%s's terminal colours are its palette's", (id) => {
    const props = block(`:root[data-app-theme='${id}']`);
    expect(props['--term-bg']).toBe(palette(id).background);
    expect(props['--term-fg']).toBe(palette(id).foreground);
  });

  it("light's and dark's terminal colours are GitHub Light's and the default palette's", () => {
    const light = block(":root,\n:root[data-theme='light']");
    expect(light['--term-bg']).toBe(palette('github-light').background);
    expect(light['--term-fg']).toBe(palette('github-light').foreground);
    expect(dark['--term-bg']).toBe(palette('default').background);
    expect(dark['--term-fg']).toBe(palette('default').foreground);
  });
});
