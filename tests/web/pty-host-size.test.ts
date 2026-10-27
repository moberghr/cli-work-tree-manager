import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The terminal's last row (Claude's status line) was cut off: FitAddon read a height that included the padding. */
const css = fs.readFileSync(path.join(__dirname, '../../src/web/src/styles/global.css'), 'utf8');
const rule = (selector: string): string => {
  const at = css.indexOf(`
${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('the terminal host', () => {
  it('is padded, and its computed size (what FitAddon fits the grid to) leaves the padding out', () => {
    expect(css).toMatch(/\*\s*\{\s*box-sizing: border-box;/); // the page's default, which counted it in
    const host = rule('.wd-pty-host');
    expect(host).toMatch(/padding: 8px/);
    expect(host).toMatch(/box-sizing: content-box/);
  });

  it("paints what the rows don't cover in the terminal's colour, not xterm.css's black", () => {
    expect(css).toMatch(/\.wd-pty-host \.xterm \.xterm-viewport \{\s*background-color: #1e1e1e;/);
  });
});
