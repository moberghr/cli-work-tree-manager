// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusLegend } from '../../src/web/src/components/Dashboard/StatusLegend.js';
import { DISPLAY_LABEL, DISPLAY_MEANING, LEGEND_KINDS, type DisplayKind } from '../../src/web/src/state/session-display.js';

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

describe('StatusLegend', () => {
  it('opens on "?" with every status colour, its name and what it means; Escape closes it', () => {
    act(() => root.render(createElement(StatusLegend)));
    const toggle = container.querySelector<HTMLButtonElement>('.wd-legend-toggle')!;
    expect(container.querySelector('.wd-legend-panel')).toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = [...container.querySelectorAll('.wd-legend-row')];
    expect(rows).toHaveLength(LEGEND_KINDS.length);
    for (const [i, k] of LEGEND_KINDS.entries()) {
      expect(rows[i].querySelector('.wd-rail-dot')!.className).toContain(`wd-rail-dot-${k}`);
      expect(rows[i].textContent).toContain(DISPLAY_LABEL[k]);
      expect(rows[i].textContent).toContain(DISPLAY_MEANING[k]);
    }
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(container.querySelector('.wd-legend-panel')).toBeNull();
  });

  it('covers every colour a dot can have', () => {
    // quiet and recent share the grey "Idle"; every other kind has its own row.
    const all = Object.keys(DISPLAY_LABEL) as DisplayKind[];
    const colours = (k: DisplayKind) => (k === 'recent' ? 'quiet' : k);
    expect(new Set(all.map(colours))).toEqual(new Set(LEGEND_KINDS));
  });
});
