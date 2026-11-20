// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { demoReview } from '../../src/server/demo/demo-reviews.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/web/src/api/panes.js', () => ({ fixReviewMyself: vi.fn() }));
const { FixMyselfDialog } = await import('../../src/web/src/components/Dashboard/FixMyselfDialog.js');

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

const fire = (el: Element, type: 'mousedown' | 'click') =>
  act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));

function open() {
  const onClose = vi.fn();
  act(() => root.render(createElement(FixMyselfDialog, { review: demoReview(), onDone: vi.fn(), onClose })));
  const backdrop = container.querySelector<HTMLElement>('[role="dialog"]')!;
  const inside = backdrop.firstElementChild!;
  return { onClose, backdrop, inside };
}

describe('Fix it myself: closing on the backdrop', () => {
  it('a press in the dialog let go outside it keeps it open', async () => {
    const { onClose, backdrop, inside } = open();
    await fire(inside, 'mousedown');
    await fire(backdrop, 'click'); // the browser sends the click where press and release meet: the backdrop
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a click on the backdrop itself closes it', async () => {
    const { onClose, backdrop } = open();
    await fire(backdrop, 'mousedown');
    await fire(backdrop, 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
