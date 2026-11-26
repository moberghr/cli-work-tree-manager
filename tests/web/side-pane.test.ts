// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { paneGoto, paneTabs, SIDE_PANE_SPEC, SidePane } from '../../src/web/src/components/Dashboard/SidePane.js';
import { paneOf } from '../../src/web/src/hooks/use-shown-file.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The pane beside a session's terminal (asked for: the diff, code or review next to the conversation, resizable). */
describe('paneTabs / paneGoto / paneOf', () => {
  it("the file's tab first, only while one is shown; then Diff, Code, Review", () => {
    expect(paneTabs(null).map((t) => t.value)).toEqual(['diff', 'code', 'review']);
    const withFile = paneTabs({ path: 'docs/spec.md' });
    expect(withFile.map((t) => t.value)).toEqual(['file', 'diff', 'code', 'review']);
    expect(withFile[0]!.label).toBe('docs/spec.md');
  });

  it('a Code place once per ask: a new ask is a new seq', () => {
    expect(paneGoto(null)).toBeNull();
    expect(paneGoto({ tab: 'diff', at: '2026-11-26T10:00:00Z' })).toBeNull();
    expect(paneGoto({ tab: 'code', at: '2026-11-26T10:00:00Z' })).toBeNull();
    const a = paneGoto({ tab: 'code', at: '2026-11-26T10:00:00Z', place: { repo: 'api', path: 'a.ts', line: 3 } });
    const b = paneGoto({ tab: 'code', at: '2026-11-26T10:00:05Z', place: { repo: 'api', path: 'a.ts', line: 3 } });
    expect(a).toMatchObject({ repo: 'api', path: 'a.ts', line: 3 });
    expect(b!.seq).not.toBe(a!.seq);
  });

  it("an older server's answer (no pane): open on the file while one is shown", () => {
    expect(paneOf({ shown: null })).toBeNull();
    expect(paneOf({ shown: { repo: 'api', path: 'a.md', at: 't', kind: 'markdown' } })).toEqual({ tab: 'file', at: 't' });
    expect(paneOf({ shown: null, pane: { tab: 'diff', at: 't' } })).toEqual({ tab: 'diff', at: 't' });
    expect(paneOf({ shown: null, pane: null })).toBeNull();
  });

  it('resized from its left edge, remembered, never narrower than a column', () => {
    expect(SIDE_PANE_SPEC).toMatchObject({ axis: 'x', invert: true, cssVar: '--side-pane-width', min: 320 });
    expect(SIDE_PANE_SPEC.storageKey).toMatch(/^work-web:/);
  });
});

describe('SidePane', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // The file's own read: never answered here.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    // The Diff view's live updates: a stream that never says anything.
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener() {}
        removeEventListener() {}
        close() {}
      },
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const session = { id: 's1', target: 'api', branch: 'feat/x', paths: ['/w/feat-x/api'], isGroup: false } as unknown as SessionSummary;
  const shown = { repo: 'api', path: 'docs/spec.md', at: 't1', kind: 'markdown' as const };
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  it('the file under its tab, without its own × (the pane has one); a tab asks the server and applies its answer; × closes', async () => {
    const opened: string[] = [];
    let closed = 0;
    const wires: unknown[] = [];
    const api = {
      open: vi.fn(async (_id: string, view: string) => {
        opened.push(view);
        return { shown, pane: { tab: view as 'diff', at: 't2' } };
      }),
      close: vi.fn(async () => void closed++),
    };
    act(() =>
      root.render(
        createElement(SidePane, {
          session,
          pane: { tab: 'file', at: 't1' },
          shown,
          onWire: (w) => void wires.push(w),
          onOpenCode: () => undefined,
          api,
        }),
      ),
    );
    const tabs = [...container.querySelectorAll('.wd-side-pane-tabs [role=tab]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['docs/spec.md', 'Diff', 'Code', 'Review']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.wd-shown-name')?.textContent).toBe('docs/spec.md');
    expect(container.querySelector('.wd-shown button[aria-label="Close"]')).toBeNull();
    // The tab that's on asks nothing.
    act(() => (tabs[0] as HTMLButtonElement).click());
    expect(opened).toEqual([]);
    act(() => (tabs[3] as HTMLButtonElement).click());
    await flush();
    expect(opened).toEqual(['review']);
    expect(wires).toEqual([{ shown, pane: { tab: 'review', at: 't2' } }]);
    act(() => (container.querySelector('.wd-side-pane-close') as HTMLButtonElement).click());
    await flush();
    expect(closed).toBe(1);
    expect(wires.at(-1)).toEqual({ shown: null, pane: null });
  });

  it('open on the file with none shown (it went): no file tab, the Diff instead', () => {
    act(() =>
      root.render(
        createElement(SidePane, {
          session,
          pane: { tab: 'file', at: 't1' },
          shown: null,
          onWire: () => undefined,
          onOpenCode: () => undefined,
          api: { open: vi.fn(), close: vi.fn() },
        }),
      ),
    );
    const tabs = [...container.querySelectorAll('.wd-side-pane-tabs [role=tab]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Diff', 'Code', 'Review']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });
});
