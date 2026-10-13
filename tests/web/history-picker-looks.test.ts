// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HistoryPicker } from '../../src/web/src/components/Diff/HistoryPicker.js';
import { historyItems, UNCOMMITTED, yourLooks, type DiffSelection } from '../../src/web/src/state/diff-history.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (id: number, minute: number) => ({ id, ts: `2026-10-06T08:${String(minute).padStart(2, '0')}:00Z`, repos: {} });
const entries = Array.from({ length: 12 }, (_, i) => entry(i, i * 4));
const items = historyItems(entries, [], null);
// Seven looks, a turn each.
const looks = yourLooks(
  items,
  entries,
  Array.from({ length: 7 }, (_, i) => ({ from: i + 1, to: i + 2, startedAt: `2026-10-06T1${i}:00:00`, at: `2026-10-06T1${i}:00:00` })),
  new Date('2026-10-06T20:00:00'),
);

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
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(text));

describe('HistoryPicker: your looks', () => {
  it('"Last look" on top, then the newest five looks above the history, the rest under Show all', () => {
    const onSelect = vi.fn<(sel: DiffSelection) => void>();
    act(() =>
      root.render(createElement(HistoryPicker, { items, selection: UNCOMMITTED, onSelect, lastTurn: null, sinceLooked: null, looks })),
    );
    act(() => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
    const sections = [...container.querySelectorAll('.wd-history-section')].map((s) => s.textContent);
    expect(sections).toEqual(['Your looks', 'History']);
    expect(container.querySelectorAll('.wd-history-row-look')).toHaveLength(5);
    act(() => button('Show all 7')!.click());
    expect(container.querySelectorAll('.wd-history-row-look')).toHaveLength(7);

    act(() => button('Last look')!.click());
    expect(onSelect.mock.calls.at(-1)?.[0]).toMatchObject({ ...looks[0].selection, label: 'Last look' });
    act(() => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
    act(() => container.querySelectorAll<HTMLButtonElement>('.wd-history-row-look')[1].click());
    expect(onSelect.mock.calls.at(-1)?.[0]).toEqual(looks[1].selection);
  });

  it('no looks: no section, no Last look', () => {
    act(() =>
      root.render(createElement(HistoryPicker, { items, selection: UNCOMMITTED, onSelect: () => {}, lastTurn: null, sinceLooked: null })),
    );
    act(() => container.querySelector<HTMLButtonElement>('.wd-history-btn')!.click());
    expect(container.querySelector('.wd-history-looks')).toBeNull();
    expect(button('Last look')).toBeUndefined();
  });
});
