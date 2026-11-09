// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffUpdateChip } from '../../src/web/src/components/Diff/DiffUpdateChip.js';

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

const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent);

describe('DiffUpdateChip', () => {
  it('Show, Only new and Reload, each doing its own thing', () => {
    const onShow = vi.fn();
    const onReload = vi.fn();
    const onShowNewOnly = vi.fn();
    act(() => root.render(createElement(DiffUpdateChip, { filesChanged: 2, onShow, onReload, onShowNewOnly })));
    expect(container.textContent).toContain('2 files');
    expect(buttons()).toEqual(['Show', 'Only new', 'Reload']);
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Only new')!.click());
    expect(onShowNewOnly).toHaveBeenCalledOnce();
    expect(onShow).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('no turn to start from: no Only new', () => {
    act(() => root.render(createElement(DiffUpdateChip, { filesChanged: 1, onShow: vi.fn(), onReload: vi.fn() })));
    expect(buttons()).toEqual(['Show', 'Reload']);
  });
});
