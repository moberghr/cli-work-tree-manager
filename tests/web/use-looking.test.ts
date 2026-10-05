// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { useLooking } = await import('../../src/web/src/apps/DashboardApp.js');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let focused = true;
let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  focused = true;
  visibility = 'visible';
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Probe() {
  return createElement('span', null, useLooking() ? 'looking' : 'away');
}

describe('useLooking (what marks a finished session seen)', () => {
  it('only while the page is visible and has focus', () => {
    act(() => root.render(createElement(Probe)));
    expect(container.textContent).toBe('looking');
    focused = false;
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(container.textContent).toBe('away'); // the app in the background, still on that session
    focused = true;
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toBe('looking');
    visibility = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(container.textContent).toBe('away'); // minimised
  });
});
