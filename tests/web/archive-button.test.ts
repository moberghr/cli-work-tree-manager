// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The session header's Archive / Restore: a refusal is said beside it, not only in a tooltip nobody hovers. */
const h = vi.hoisted(() => ({ setArchived: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  setArchived: (id: string, archived: boolean, _confirm: unknown, opts: unknown) => h.setArchived(id, archived, opts),
}));

const { ArchiveButton } = await import('../../src/web/src/components/Dashboard/SessionDetail.js');

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

describe('ArchiveButton (the session header)', () => {
  it("Archive asks with the session's name", async () => {
    h.setArchived.mockResolvedValue({ ok: true });
    act(() => root.render(createElement(ArchiveButton, { sessionId: 's1', name: 'feat/x', archived: false })));
    await act(async () => container.querySelector<HTMLButtonElement>('.wd-session-archive')!.click());
    expect(h.setArchived).toHaveBeenCalledWith('s1', true, { name: 'feat/x' });
  });

  it('a Restore refused: why goes to the header (onError), the button says ⚠ and keeps it as its tooltip', async () => {
    const why = "Couldn't restore it: a file in its folder is in use (Visual Studio?): close it and try again";
    h.setArchived.mockRejectedValue(new Error(why));
    const onStart = vi.fn();
    const onError = vi.fn();
    act(() => root.render(createElement(ArchiveButton, { sessionId: 's1', archived: true, onStart, onError })));
    const btn = () => container.querySelector<HTMLButtonElement>('.wd-session-archive')!;
    await act(async () => {
      btn().click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onStart).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(why);
    expect(btn().textContent).toBe('Restore ⚠');
    expect(btn().title).toBe(why);
  });

  it('archived or restored some other way meanwhile: the ⚠ of the last try is over', async () => {
    h.setArchived.mockRejectedValue(new Error('refused'));
    act(() => root.render(createElement(ArchiveButton, { sessionId: 's1', archived: false })));
    const btn = () => container.querySelector<HTMLButtonElement>('.wd-session-archive')!;
    await act(async () => {
      btn().click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(btn().textContent).toBe('Archive ⚠');
    // Archived from the rail (or a key, or the PR watch): not a "Restore ⚠" with the old refusal.
    act(() => root.render(createElement(ArchiveButton, { sessionId: 's1', archived: true })));
    expect(btn().textContent).toBe('Restore');
  });

  it('"Archive it anyway?" → Cancel is your choice: no error shown', async () => {
    h.setArchived.mockRejectedValue(Object.assign(new Error('Not archived: a reply draft'), { cancelled: true }));
    const onError = vi.fn();
    act(() => root.render(createElement(ArchiveButton, { sessionId: 's1', archived: false, onError })));
    const btn = () => container.querySelector<HTMLButtonElement>('.wd-session-archive')!;
    await act(async () => {
      btn().click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onError).not.toHaveBeenCalled();
    expect(btn().textContent).toBe('Archive');
  });
});
