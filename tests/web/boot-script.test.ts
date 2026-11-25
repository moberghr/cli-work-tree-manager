// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_THEMES } from '../../src/core/settings/app-theme.js';

/**
 * SC12, no flash: index.html's inline boot script paints the cached theme on <html> before the first frame, as the
 * appearance store (state/appearance.ts) will once the app loads. It is run here as the page runs it.
 */

const page = fs.readFileSync(path.join(__dirname, '../../src/web/index.html'), 'utf8');
// The inline one (no `src`): the module script loads the app.
const boot = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const html = document.documentElement;

let osDark = false;
function runBoot(cached?: string) {
  if (cached !== undefined) localStorage.setItem('wd:theme', cached);
  new Function(boot[0]!)();
}

beforeEach(() => {
  osDark = false;
  localStorage.clear();
  delete html.dataset.theme;
  delete html.dataset.appTheme;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ media: query, matches: query === '(prefers-color-scheme: dark)' && osDark }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the boot script in index.html', () => {
  it('is the one inline script', () => {
    expect(boot).toHaveLength(1);
    expect(boot[0]).toContain("localStorage.getItem('wd:theme')");
  });

  it('a cached named theme paints dark with its own data-app-theme', () => {
    runBoot('dracula');
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.appTheme).toBe('dracula');
  });

  it("paints every app theme as the store does: its base, and a named one's id", () => {
    for (const t of APP_THEMES) {
      delete html.dataset.appTheme;
      osDark = t.base === 'light'; // the OS says the opposite: the cache must win
      runBoot(t.id);
      expect(html.dataset.theme, t.id).toBe(t.base);
      expect(html.dataset.appTheme, t.id).toBe(t.id === t.base ? undefined : t.id);
    }
  });

  it('a cached light wins over a dark OS', () => {
    osDark = true;
    runBoot('light');
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.appTheme).toBeUndefined();
  });

  it('nothing cached follows the OS', () => {
    osDark = true;
    runBoot();
    expect(html.dataset.theme).toBe('dark');
    osDark = false;
    runBoot();
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.appTheme).toBeUndefined();
  });

  it('a cached value that is no theme follows the OS', () => {
    osDark = true;
    runBoot('purple');
    expect(html.dataset.theme).toBe('dark');
    expect(html.dataset.appTheme).toBeUndefined();
  });

  it('a browser that refuses localStorage gets light', () => {
    osDark = true;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    runBoot();
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.appTheme).toBeUndefined();
  });
});
