// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CheckpointStrip } from '../../src/web/src/components/Diff/CheckpointStrip.js';
import type { CheckpointEntry } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const entries: CheckpointEntry[] = [
  { id: 0, ts: '2026-06-03T12:00:00.000Z', label: 'Initial', repos: {} },
  { id: 1, ts: '2026-06-03T12:01:00.000Z', repos: {} },
];

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

function render(busy: boolean) {
  act(() => {
    root.render(
      createElement(CheckpointStrip, {
        entries,
        fromId: 0,
        toId: 'working',
        onSelect: () => {},
        onExtend: () => {},
        busy,
      }),
    );
  });
}

describe('CheckpointStrip busy indicator', () => {
  it('shows a spinner and marks the strip aria-busy while loading', () => {
    render(true);
    expect(container.querySelector('.wd-checkpoint-spinner')).not.toBeNull();
    expect(
      container.querySelector('.wd-checkpoint-strip')?.getAttribute('aria-busy'),
    ).toBe('true');
  });

  it('hides the spinner when not loading', () => {
    render(false);
    expect(container.querySelector('.wd-checkpoint-spinner')).toBeNull();
  });
});
