import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The full-screen diff covers the page but not what a key can open over it
 * (Ship, Fork, a row's menu, Ctrl+K, the shortcuts): one that drew under it
 * would take the keyboard unseen.
 */
const css = ['global.css', 'dashboard.css', 'review.css']
  .map((f) => fs.readFileSync(path.join(__dirname, '../../src/web/src/styles', f), 'utf8'))
  .join('\n');
const zOf = (selector: string): number => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const rule = css.slice(at, css.indexOf('}', at));
  return Number(/z-index:\s*(\d+)/.exec(rule)![1]);
};

describe('the full-screen diff, by layer', () => {
  it('above the rail; under the assistant, dialogs and menus', () => {
    const full = zOf('.wd-session-subtab-body.wd-diff-full');
    expect(full).toBeGreaterThan(20); // the rail's overlay
    for (const over of ['.wd-assistant', '.wd-modal-backdrop', '.wd-row-menu', '.wd-legend-panel'])
      expect(zOf(over), over).toBeGreaterThan(full);
  });
});
