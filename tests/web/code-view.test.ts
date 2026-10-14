// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeFileWire, CodeFilesWire } from '../../src/core/api-types.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  files: null as unknown as CodeFilesWire,
  texts: {} as Record<string, string | null>,
  sse: {} as Record<string, () => void>,
}));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchCodeFiles: vi.fn(async () => h.files),
  fetchCodeFile: vi.fn(async (_id: string, repo: string, path: string): Promise<CodeFileWire> => {
    const text = h.texts[path];
    return text === null
      ? { repo, path, size: 8, text: null, reason: 'binary' }
      : { repo, path, size: (text ?? '').length, text: text ?? '' };
  }),
}));
vi.mock('../../src/web/src/api/events.js', () => ({
  useSse: (_url: string, handlers: { events: Record<string, () => void> }) => void (h.sse = handlers.events),
}));
const { CodeView } = await import('../../src/web/src/components/Code/CodeView.js');

const session = { id: 'code-s1', target: 'api', branch: 'feat/x', isGroup: false, paths: ['/wt/api'] } as unknown as SessionSummary;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.files = {
    group: false,
    rootFiles: [],
    repos: [{ name: 'api', files: ['README.md', 'src/cart.ts', 'src/logo.png'], changed: ['src/cart.ts'], truncated: false }],
  };
  h.texts = { 'README.md': '# api\n', 'src/cart.ts': 'const a = 1;\nconst b = 2;\n', 'src/logo.png': null };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('.wd-code-row')];
const row = (text: string) => rows().find((r) => r.textContent?.startsWith(text))!;
const lines = () => [...container.querySelectorAll('.wd-fileview-content')].map((td) => td.textContent);

async function mount(id = 'code-s1', onShowDiff = vi.fn()) {
  act(() => root.render(createElement(CodeView, { session: { ...session, id }, onShowDiff })));
  await flush();
  return onShowDiff;
}

describe('the Code tab', () => {
  it('folders start folded; a file opens read only, a changed one with a dot and "See the change"', async () => {
    const onShowDiff = await mount();
    expect(rows().map((r) => r.textContent)).toEqual(['▸src1', 'README.md']); // src holds one changed file
    act(() => row('▸src').click());
    expect(rows().map((r) => r.textContent)).toEqual(['▾src1', 'cart.ts', 'logo.png', 'README.md']);
    expect(row('cart.ts').querySelector('.wd-code-dot')).not.toBeNull();
    act(() => row('cart.ts').click());
    await flush();
    expect(lines()).toEqual(['const a = 1;', 'const b = 2;']);
    expect(container.querySelector('.wd-code-path')!.textContent).toBe('src/cart.ts');
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('See the change'))!.click());
    expect(onShowDiff).toHaveBeenCalled();
  });

  it('the filter finds a file anywhere; Enter opens the first', async () => {
    await mount('code-s2');
    const input = container.querySelector<HTMLInputElement>('.wd-code-filter')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'cart');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows().map((r) => r.textContent)).toEqual(['src/cart.ts']);
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
    expect(lines()).toEqual(['const a = 1;', 'const b = 2;']);
  });

  it('a file Claude changes while open is not swapped under you: "File changed · Reload"', async () => {
    await mount('code-s3');
    act(() => row('README.md').click());
    await flush();
    expect(lines()).toEqual(['# api']);
    vi.useFakeTimers();
    h.texts['README.md'] = '# api\n\nMore.\n';
    act(() => h.sse['diff-changed']());
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    vi.useRealTimers();
    await flush();
    expect(lines()).toEqual(['# api']); // still what you were reading
    const reload = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload')!;
    expect(container.textContent).toContain('File changed');
    act(() => reload.click());
    expect(lines()).toEqual(['# api', ' ', 'More.']); // a blank line keeps its height
  });

  it('a binary file says so instead of showing bytes', async () => {
    await mount('code-s4');
    act(() => row('▸src').click());
    act(() => row('logo.png').click());
    await flush();
    expect(container.querySelector('.wd-code-note')!.textContent).toContain('binary');
  });
});
