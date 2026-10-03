// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SnoozeUntilDialog, whenPreview } from '../../src/web/src/components/Dashboard/SnoozeUntilDialog.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('whenPreview', () => {
  it('says what the time means, or why it is none', () => {
    const now = new Date(2026, 9, 1, 15, 0);
    expect(whenPreview('16:00', now).at).toEqual(new Date(2026, 9, 1, 16, 0));
    expect(whenPreview('someday', now)).toMatchObject({ at: null, text: expect.stringContaining('Not a time') });
    expect(whenPreview('2026-09-30', now)).toMatchObject({ at: null, text: 'That is in the past' });
    expect(whenPreview('+40d', now)).toMatchObject({ at: null, text: expect.stringContaining('At most 30 days') });
    expect(whenPreview('', now).at).toBeNull();
  });
});

describe('SnoozeUntilDialog', () => {
  it('starts on tomorrow 9:00; a bad time cannot be picked; a good one is picked as ISO', () => {
    const onPick = vi.fn();
    act(() => root.render(createElement(SnoozeUntilDialog, { onPick, onClose: () => {} })));
    const input = container.querySelector('input')!;
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(container.querySelector('[role="status"]')!.textContent).toMatch(/^Until /);
    const type = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('whenever');
    expect(submit.disabled).toBe(true);
    type('+2h');
    expect(submit.disabled).toBe(false);
    act(() => void container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const iso = onPick.mock.calls[0][0] as string;
    expect(Math.abs(Date.parse(iso) - (Date.now() + 2 * 3600_000))).toBeLessThan(60_000);
  });
});
