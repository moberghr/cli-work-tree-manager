// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusIcon } from '../../src/web/src/components/Dashboard/StatusIcon.js';
import { DISPLAY_LABEL, type DisplayKind } from '../../src/web/src/state/session-display.js';

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

const KINDS = Object.keys(DISPLAY_LABEL) as DisplayKind[];

describe('StatusIcon', () => {
  it('draws a glyph for every status, keeping the class names views and tests find a status by', () => {
    for (const kind of KINDS) {
      act(() => root.render(createElement(StatusIcon, { kind })));
      const el = container.querySelector('.wd-rail-dot')!;
      expect(el.className).toBe(`wd-rail-dot wd-rail-dot-${kind} wd-status-icon`);
      expect(el.querySelector('svg')!.children.length).toBeGreaterThan(0);
      expect(el.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('labelled: it says the status (the rail, where it stands alone)', () => {
    act(() => root.render(createElement(StatusIcon, { kind: 'needs_input', labelled: true })));
    const el = container.querySelector('.wd-rail-dot')!;
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Needs your input');
    expect(el.getAttribute('title')).toMatch(/^Needs your input: /);
  });

  it('working turns; the statuses that mean different things look different', () => {
    act(() => root.render(createElement(StatusIcon, { kind: 'working' })));
    expect(container.querySelector('.wd-status-spin')).not.toBeNull();
    const shape = (kind: DisplayKind) => {
      act(() => root.render(createElement(StatusIcon, { kind })));
      return container.querySelector('svg')!.innerHTML;
    };
    const distinct = new Set(
      ['needs_input', 'done', 'working', 'review', 'quiet', 'active', 'open', 'stale'].map((k) => shape(k as DisplayKind)),
    );
    expect(distinct.size).toBe(8);
    expect(shape('recent')).toBe(shape('quiet')); // both read "Idle"
  });
});
