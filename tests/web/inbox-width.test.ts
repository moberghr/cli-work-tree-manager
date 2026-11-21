import { describe, expect, it } from 'vitest';
import { allStylesheets } from './stylesheets.js';

/** #59: the Inbox's list spans the page, as the Sessions table does, and the name column grows with it. */
const css = allStylesheets();
const rule = (selector: string): string => {
  const at = css.indexOf(`
${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('the Inbox, by width', () => {
  it('its sections take the page width (no cap), and a name gets up to 360px before it is cut', () => {
    expect(rule('.wd-inbox-section')).not.toMatch(/max-width/);
    expect(rule('.wd-inbox-row')).toMatch(/grid-template-columns: 16px minmax\(160px, 360px\) minmax\(0, 1fr\) 56px/);
  });
});
