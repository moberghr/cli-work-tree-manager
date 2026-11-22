// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { StatusLineAsk } = await import('../../src/web/src/components/Dashboard/StatusLineAsk.js');

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
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const settings = (values: Record<string, unknown>): SettingsWire => ({ values, configPath: '/c.json' });

describe('StatusLineAsk', () => {
  it('asks while the setting was never set; Show it saves work, and the card goes', async () => {
    const save = vi.fn(async () => settings({ claudeStatusLine: 'work' }));
    const load = async () => settings({});
    act(() => root.render(createElement(StatusLineAsk, { load, save })));
    await flush();
    expect(container.textContent).toContain('Show a status line under each Claude?');
    act(() => button('Show it')!.click());
    await flush();
    expect(save).toHaveBeenCalledWith('claudeStatusLine', 'work');
    expect(container.textContent).toBe('');
  });

  it('Keep mine saves own', async () => {
    const save = vi.fn(async () => settings({ claudeStatusLine: 'own' }));
    const load = async () => settings({});
    act(() => root.render(createElement(StatusLineAsk, { load, save })));
    await flush();
    act(() => button('Keep mine')!.click());
    await flush();
    expect(save).toHaveBeenCalledWith('claudeStatusLine', 'own');
  });

  it('asks nothing of someone with a status line of their own: theirs stays', async () => {
    const load = async (): Promise<SettingsWire> => ({ ...settings({}), ownStatusLine: true });
    act(() => root.render(createElement(StatusLineAsk, { load })));
    await flush();
    expect(container.textContent).toBe('');
  });

  it('asks nothing once answered, or when the settings did not read', async () => {
    const answered = async () => settings({ claudeStatusLine: 'own' });
    act(() => root.render(createElement(StatusLineAsk, { load: answered })));
    await flush();
    expect(container.textContent).toBe('');
    const failing = () => Promise.reject(new Error('down'));
    act(() => root.render(createElement(StatusLineAsk, { load: failing })));
    await flush();
    expect(container.textContent).toBe('');
  });

  it('a save that fails says why and keeps the card', async () => {
    const load = async () => settings({});
    const save = () => Promise.reject(new Error('config.json is locked'));
    act(() => root.render(createElement(StatusLineAsk, { load, save })));
    await flush();
    act(() => button('Show it')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('config.json is locked');
    expect(button('Show it')!.disabled).toBe(false);
  });
});
