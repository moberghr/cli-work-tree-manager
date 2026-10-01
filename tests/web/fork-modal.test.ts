// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ forkSession: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  forkSession: (id: string, req: unknown) => api.forkSession(id, req),
}));
const { ForkSessionModal, suggestForkBranch } = await import('../../src/web/src/components/Dashboard/ForkSessionModal.js');
const { sessionMenuItems } = await import('../../src/web/src/state/session-menu.js');

const session = (branch: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: `id-${branch}`, target: 'api', branch, isGroup: false, paths: [], createdAt: '', lastAccessedAt: '', activityState: 'stale', diffStat: { files: 2, added: 5, deleted: 1 }, ...over }) as SessionSummary;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.forkSession.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('suggestForkBranch', () => {
  it('the next free -N', () => {
    expect(suggestForkBranch('feat/x', new Set())).toBe('feat/x-2');
    expect(suggestForkBranch('feat/x', new Set(['feat/x-2', 'feat/x-3']))).toBe('feat/x-4');
    expect(suggestForkBranch('feat/x-2', new Set(['feat/x-2']))).toBe('feat/x-3');
  });
});

describe('ForkSessionModal', () => {
  it('suggests a free branch, says what stays behind, and forks with what you typed — busy until it exists', async () => {
    let resolve!: (v: unknown) => void;
    api.forkSession.mockReturnValue(new Promise((r) => (resolve = r)));
    const onForked = vi.fn();
    const s = session('feat/x');
    act(() => root.render(createElement(ForkSessionModal, { session: s, sessions: [s, session('feat/x-2')], onForked, onClose: () => {} })));
    const [branch, name] = [...container.querySelectorAll<HTMLInputElement>('input')];
    expect(branch.value).toBe('feat/x-3');
    expect(container.textContent).toContain('its 2 uncommitted files stay here');
    type(name, 'Try Redis');
    type(container.querySelector('textarea')!, 'Use Redis for the queue');
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(api.forkSession).toHaveBeenCalledWith('id-feat/x', { branch: 'feat/x-3', name: 'Try Redis', prompt: 'Use Redis for the queue' });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('writing a summary of the conversation');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent).toBe('Forking…');
    await act(async () => resolve({ sessionId: 'new', paths: [], summarized: true }));
    expect(onForked).toHaveBeenCalledWith('new', { summarized: true });
  });

  it("shows the server's refusal and lets you change the name", async () => {
    api.forkSession.mockRejectedValue(new Error('feat/x-2 already exists (api): pick another name'));
    const s = session('feat/x');
    act(() => root.render(createElement(ForkSessionModal, { session: s, sessions: [s], onForked: vi.fn(), onClose: () => {} })));
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already exists');
    expect(container.querySelector<HTMLInputElement>('input')!.disabled).toBe(false);
  });
});

describe('the row menu', () => {
  it('offers Fork… for a live session, not an archived one', () => {
    const a = { setArchived: vi.fn(), openTerminal: vi.fn(), openEditor: vi.fn(), copyBranch: vi.fn(), remove: vi.fn(), snooze: vi.fn(), unsnooze: vi.fn(), fork: vi.fn() };
    const items = sessionMenuItems(session('feat/x'), a);
    items.find((i) => i.label === 'Fork…')!.run();
    expect(a.fork).toHaveBeenCalled();
    expect(sessionMenuItems(session('feat/x', { archivedAt: 'x' }), a).some((i) => i.label === 'Fork…')).toBe(false);
  });
});
