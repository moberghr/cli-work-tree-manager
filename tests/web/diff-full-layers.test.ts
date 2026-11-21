import { describe, expect, it } from 'vitest';
import { allStylesheets } from './stylesheets.js';

/**
 * The full-screen diff covers the page but not what a key can open over it
 * (Ship, Fork, a row's menu, Ctrl+K, the shortcuts): one that drew under it
 * would take the keyboard unseen.
 */
// Every stylesheet: the menu is a shared piece (ui/ui.css), a session's page has its own (styles/pages/).
const css = allStylesheets();
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
