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
  { id: 1, ts: '2026-06-03T12:01:00.000Z', label: 'add resolve route', repos: {} },
  { id: 2, ts: '2026-06-03T12:02:00.000Z', repos: {} },
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

function render(props: Partial<Parameters<typeof CheckpointStrip>[0]> = {}) {
  act(() => {
    root.render(
      createElement(CheckpointStrip, {
        entries,
        fromId: 0,
        toId: 'working',
        onChangeFrom: () => {},
        onChangeTo: () => {},
        onPickSingle: () => {},
        active: true,
        ...props,
      }),
    );
  });
}

const q = <T extends Element>(s: string) => container.querySelector<T>(s);
const openMenu = () => act(() => q<HTMLButtonElement>('.wd-checkpoint-range-btn')!.click());
const rows = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('.wd-checkpoint-pop-row'));
const rowByText = (t: string) =>
  rows().find((r) => r.textContent?.includes(t))!;

describe('CheckpointStrip (GitHub-style single dropdown)', () => {
  it('is a single trigger button showing the from → to range', () => {
    render({ fromId: 0, toId: 2 });
    const btn = q('.wd-checkpoint-range-btn');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Initial'); // from #0 label
    expect(btn!.textContent).toContain('#2'); // to #2 (no summary → #id)
    // Popover is closed until clicked.
    expect(q('.wd-checkpoint-pop')).toBeNull();
  });

  it('opens a popover listing every checkpoint under a pinned "All changes" preset', () => {
    render();
    openMenu();
    expect(q('.wd-checkpoint-pop')).not.toBeNull();
    // "All changes" reset lives in the sticky header (no standalone Working row).
    expect(q('.wd-checkpoint-pop-header .wd-checkpoint-pop-preset')).not.toBeNull();
    expect(rows()).toHaveLength(entries.length);
    expect(rowByText('add resolve route')).toBeTruthy(); // cached summary shown
  });

  it('marks "All changes" active when the range is Initial → Working', () => {
    render({ fromId: 0, toId: 'working' });
    openMenu();
    expect(
      q('.wd-checkpoint-pop-preset')!.classList.contains(
        'wd-checkpoint-pop-preset-active',
      ),
    ).toBe(true);
  });

  it('plain click selects a single checkpoint; shift+click widens the start', () => {
    const single: Array<number | 'working'> = [];
    const from: number[] = [];
    render({ onPickSingle: (v) => single.push(v), onChangeFrom: (v) => from.push(v) });
    openMenu();

    act(() => rowByText('add resolve route').click()); // plain → single checkpoint #1
    act(() =>
      rowByText('add resolve route').dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: true }),
      ),
    ); // shift+click → set start = 1
    expect(single).toEqual([1]);
    expect(from).toEqual([1]);
  });

  it('the "All changes" preset sets Initial → Working', () => {
    const to: Array<number | 'working'> = [];
    const from: number[] = [];
    render({ onChangeTo: (v) => to.push(v), onChangeFrom: (v) => from.push(v) });
    openMenu();
    act(() => q<HTMLButtonElement>('.wd-checkpoint-pop-preset')!.click());
    expect(from).toEqual([0]);
    expect(to).toEqual(['working']);
  });

  it('carries busy as aria-busy only — no second spinner in the toolbar', () => {
    // The visible in-flight cue is the header's busy chip; a spinner here
    // would say the same thing twice, a few pixels apart.
    render({ toId: 2, busy: true });
    expect(q('.wd-checkpoint-range')!.getAttribute('aria-busy')).toBe('true');
    expect(q('.wd-checkpoint-spinner')).toBeNull();
  });

  it('shows the selected range on the trigger, with no trailing summary text', () => {
    // Labels come from the entries themselves; an unnamed checkpoint reads
    // as #id. Nothing trails the picker any more.
    render({ fromId: 1, toId: 2 });
    const trigger = q('.wd-checkpoint-btn-range')!.textContent!;
    expect(trigger).toContain('add resolve route');
    expect(trigger).toContain('#2');
    expect(q('.wd-checkpoint-summary')).toBeNull();
  });
});
