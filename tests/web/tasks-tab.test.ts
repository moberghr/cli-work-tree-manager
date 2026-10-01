// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TaskItem } from '../../src/web/src/api/panes.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tasks: TaskItem[] = [];
const updateTask = vi.fn(async (id: number, patch: { text?: string; done?: boolean }) => {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
  return { tasks };
});
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchTasks: async () => ({ tasks }),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  updateTask: (id: number, patch: { text?: string; done?: boolean }) => updateTask(id, patch),
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));

const { TasksTab } = await import('../../src/web/src/components/Dashboard/tabs/TasksTab.js');

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  tasks = [{ id: 1, text: 'old text', done: false, createdAt: '' } as TaskItem];
  updateTask.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(TasksTab, { onPick: () => {} })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const textEl = () => container.querySelector<HTMLElement>('.wd-task-text');
const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Task text"]');
const type = (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('TasksTab: editing a task', () => {
  it('click the text, change it, Enter saves', async () => {
    await act(async () => textEl()!.click());
    expect(field()!.value).toBe('old text');
    await act(async () => type(field()!, 'new text'));
    await act(async () => key(field()!, 'Enter'));
    expect(updateTask).toHaveBeenCalledWith(1, { text: 'new text' });
    expect(textEl()!.textContent).toBe('new text');
  });

  it('Esc puts it back without saving; clicking the text no longer ticks it off', async () => {
    await act(async () => textEl()!.click());
    await act(async () => type(field()!, 'scratch'));
    await act(async () => key(field()!, 'Escape'));
    expect(updateTask).not.toHaveBeenCalled();
    expect(textEl()!.textContent).toBe('old text');
  });

  it('right-click → Edit edits it too', async () => {
    const row = container.querySelector('.wd-task-row')!;
    await act(async () => void row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.textContent).toContain('Edit');
    await act(async () => item.click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(field()!.value).toBe('old text');
    await act(async () => type(field()!, 'from the menu'));
    await act(async () => key(field()!, 'Enter'));
    expect(updateTask).toHaveBeenCalledWith(1, { text: 'from the menu' });
  });

  it('F2 on the text starts editing; unchanged or empty text saves nothing', async () => {
    await act(async () => key(textEl()!, 'F2'));
    await act(async () => type(field()!, '   '));
    await act(async () => key(field()!, 'Enter'));
    await act(async () => key(textEl()!, 'F2'));
    await act(async () => key(field()!, 'Enter'));
    expect(updateTask).not.toHaveBeenCalled();
  });
});
