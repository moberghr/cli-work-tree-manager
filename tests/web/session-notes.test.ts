// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchNote: vi.fn(), saveNote: vi.fn(), sendPromptToSession: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchNote: (id: string) => api.fetchNote(id),
  saveNote: (id: string, t: string) => api.saveNote(id, t),
  sendPromptToSession: (id: string, t: string) => api.sendPromptToSession(id, t),
}));
const { SessionNotes, NotesChip } = await import('../../src/web/src/components/Dashboard/SessionNotes.js');

const session = (over: Partial<SessionSummary> = {}) => ({ id: 's1', target: 'api', branch: 'feat/x', ...over }) as SessionSummary;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  api.fetchNote.mockReset().mockResolvedValue({ text: 'earlier', updatedAt: '' });
  api.saveNote.mockReset().mockResolvedValue(undefined);
  api.sendPromptToSession.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const type = (v: string) =>
  act(() => {
    const t = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(t, v);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('SessionNotes', () => {
  it('loads them, saves after a pause in typing (once, the latest), says so; Send to Claude hands them over', async () => {
    await act(async () => root.render(createElement(SessionNotes, { session: session(), onClose: () => {} })));
    expect(container.querySelector('textarea')!.value).toBe('earlier');
    type('earlier\nmore');
    type('earlier\nmore and more');
    expect(container.textContent).toContain('Saving…');
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    expect(api.saveNote).toHaveBeenCalledWith('s1', 'earlier\nmore and more');
    expect(container.textContent).toContain('Saved');
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send to Claude')!.click());
    expect(api.sendPromptToSession).toHaveBeenCalledWith('s1', 'A note from me on this session:\n\nearlier\nmore and more');
    expect(container.textContent).toContain('Sent to its Claude');
  });

  it('closing with a save still pending saves it', async () => {
    await act(async () => root.render(createElement(SessionNotes, { session: session(), onClose: () => {} })));
    type('last words');
    act(() => root.render(createElement('div')));
    expect(api.saveNote).toHaveBeenCalledWith('s1', 'last words');
  });

  it('the chip shows when there are notes', () => {
    act(() => root.render(createElement(NotesChip, { session: session({ hasNote: true }), open: false, onToggle: () => {} })));
    expect(container.textContent).toBe('📝 Notes •');
  });
});
