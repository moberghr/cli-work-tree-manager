// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SPIN_MS, StatusIcon, spinPhase } from '../../src/web/src/components/Dashboard/StatusIcon.js';
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

  it('the whole svg turns, never a group inside it (WebKit started that one over on every update of its row)', () => {
    for (const kind of KINDS) {
      act(() => root.render(createElement(StatusIcon, { kind })));
      const svg = container.querySelector('svg')!;
      const spins = ['working', 'background', 'archiving', 'restoring'].includes(kind);
      expect(svg.classList.contains('wd-status-spin')).toBe(spins);
      expect(svg.style.animationDelay !== '').toBe(spins);
      expect(svg.querySelector('.wd-status-spin')).toBeNull();
    }
  });

  it('a spinner keeps its element and its phase while its row updates', () => {
    act(() => root.render(createElement(StatusIcon, { kind: 'working' })));
    const svg = container.querySelector('svg')!;
    const delay = svg.style.animationDelay;
    // The row around it re-renders: a new status of the same kind, muted, labelled.
    act(() => root.render(createElement(StatusIcon, { kind: 'background', labelled: true })));
    act(() => root.render(createElement(StatusIcon, { kind: 'working', muted: true })));
    expect(container.querySelector('svg')).toBe(svg);
    expect(svg.style.animationDelay).toBe(delay);
  });

  it('starts where the wall clock is in a turn, so one drawn again carries on in step', () => {
    expect(spinPhase(5 * SPIN_MS)).toBe('0ms');
    expect(spinPhase(5 * SPIN_MS + 250)).toBe('-250ms');
    expect(spinPhase(5 * SPIN_MS + SPIN_MS - 1)).toBe(`-${SPIN_MS - 1}ms`);
  });
});
