// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { archivePending, trackArchive, useArchivePending } from '../../src/web/src/api/archive-pending.js';

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
  vi.restoreAllMocks();
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

function Label({ id }: { id: string }) {
  const p = useArchivePending(id);
  return createElement('span', null, p === undefined ? 'Archive' : p ? 'Archiving…' : 'Restoring…');
}

describe('archives in flight', () => {
  it('a new button for the session — after going to another one and back — still says Archiving…, until it is done', async () => {
    const d = deferred();
    void trackArchive('s1', true, d.promise);
    act(() => root.render(createElement(Label, { id: 's1' })));
    expect(container.textContent).toBe('Archiving…');
    act(() => root.render(createElement(Label, { id: 's2' }))); // another session
    expect(container.textContent).toBe('Archive');
    act(() => root.render(createElement(Label, { id: 's1' }))); // back
    expect(container.textContent).toBe('Archiving…');
    await act(async () => {
      d.resolve();
      await d.promise;
    });
    expect(container.textContent).toBe('Archive');
    expect(archivePending('s1')).toBeUndefined();
  });

  it('a failed one ends too, and a restore reads as restoring', async () => {
    const d = deferred();
    const p = trackArchive('s3', false, d.promise);
    expect(archivePending('s3')).toBe(false);
    d.reject(new Error('nope'));
    await expect(p).rejects.toThrow('nope');
    await Promise.resolve();
    expect(archivePending('s3')).toBeUndefined();
  });

  it('setArchived records every call (the header, the Sessions table and the inbox share it)', async () => {
    const { setArchived } = await import('../../src/web/src/api/client.js');
    const d = deferred();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await d.promise;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const call = setArchived('s4', true);
    expect(archivePending('s4')).toBe(true);
    d.resolve();
    await call;
    await Promise.resolve();
    expect(archivePending('s4')).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
