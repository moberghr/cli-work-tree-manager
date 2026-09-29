// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCommentJump } from '../../src/web/src/hooks/use-comment-jump.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const ref = useRef<HTMLElement>(null);
  useCommentJump(ref);
  return createElement(
    'main',
    { ref },
    createElement('table', null,
      createElement('tbody', null,
        ['a', 'b', 'c'].map((id) => createElement('tr', { key: id, id, className: 'wd-comment-row' })),
      ),
    ),
    createElement('textarea', { id: 'field' }),
  );
}

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const flashed = () => [...container.querySelectorAll('.wd-row-flash')].map((e) => e.id);

describe('] / [ comment navigation', () => {
  it('walks threads forward and back, wrapping around', () => {
    press(']');
    expect(flashed()).toEqual(['a']);
    press(']');
    press(']');
    expect(flashed().at(-1)).toBe('c');
    press(']');
    expect(flashed()).toContain('a');
    press('[');
    expect(document.querySelector('#c')!.classList.contains('wd-row-flash')).toBe(true);
  });

  it('starts from the last thread going backwards', () => {
    press('[');
    expect(flashed()).toEqual(['c']);
  });

  it('leaves typing alone', () => {
    (document.querySelector('#field') as HTMLTextAreaElement).focus();
    press(']');
    expect(flashed()).toEqual([]);
  });
});
