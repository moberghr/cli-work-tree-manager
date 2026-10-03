// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { modalOpen } from '../../src/web/src/state/modal-open.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('modalOpen: what takes the keyboard from the shortcuts', () => {
  it('a dialog, a confirm or a modal does', () => {
    for (const html of ['<div role="dialog"></div>', '<div role="alertdialog"></div>', '<div aria-modal="true"></div>']) {
      document.body.innerHTML = html;
      expect(modalOpen(), html).toBe(true);
    }
  });

  it('a popover (Tasks, Activity, the legend) does not: g t closes the panel it opened', () => {
    document.body.innerHTML = '<div role="dialog" data-popover aria-label="Tasks"></div>';
    expect(modalOpen()).toBe(false);
    document.body.innerHTML = '';
    expect(modalOpen()).toBe(false);
  });
});
