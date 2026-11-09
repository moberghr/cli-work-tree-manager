// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RepoSettingsWire, SettingsWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => undefined }));

const { SettingsTab } = await import('../../src/web/src/components/Dashboard/tabs/SettingsTab.js');
const { RepoSettings } = await import('../../src/web/src/components/Dashboard/RepoSettings.js');
const { defaultText, parseList, settingSections, shownValue } = await import('../../src/web/src/state/settings-view.js');
const { settingAt } = await import('../../src/core/settings/settings-schema.js');
const { parseHash, toHash } = await import('../../src/web/src/state/dashboard-route.js');
const { shortcutGroups } = await import('../../src/web/src/state/shortcuts.js');

/** The Settings page (#/settings) and a repo's settings (#/repos/<alias>). */

describe('reading settings for the screen (pure)', () => {
  it('a written value shows as set; otherwise the default, said in words', () => {
    const f = settingAt('sleepIdleAfterMinutes')!;
    expect(shownValue(f, { sleepIdleAfterMinutes: 20 })).toEqual({ value: 20, set: true });
    expect(shownValue(f, {})).toEqual({ value: 10, set: false });
    expect(defaultText(settingAt('prWatch.fixCi')!)).toBe('on');
    expect(defaultText(settingAt('copyFiles')!)).toBe('none');
    expect(defaultText(settingAt('archive.dropTranscriptsAfterDays')!)).toBe('0 (off)');
    expect(defaultText(settingAt('time.gapTicket')!)).toBeNull();
  });

  it('a list is one entry a line (a glob keeps its commas)', () => {
    expect(parseList(' a.json\n\n*.{json,env}\r\nb ')).toEqual(['a.json', '*.{json,env}', 'b']);
  });

  it('the filter finds a setting by its words, in its section', () => {
    expect(settingSections('idle').map((s) => [s.section, s.fields.map((f) => f.path)])).toEqual([
      ['Agents & terminals', ['sleepIdleAfterMinutes']],
    ]);
    expect(settingSections('').length).toBe(7);
  });

  it('#/settings and #/repos/<alias> are pages of their own; g , opens Settings', () => {
    expect(parseHash('#/settings')).toMatchObject({ tab: 'settings', sessionId: null });
    expect(parseHash('#/repos/straumur-backend')).toMatchObject({ tab: 'repos', repo: 'straumur-backend' });
    expect(parseHash('#/repos')).toMatchObject({ tab: 'repos' });
    expect(parseHash('#/repos').repo).toBeUndefined();
    expect(toHash(parseHash('#/repos/a.b'))).toBe('#/repos/a.b');
    expect(
      shortcutGroups()
        .flatMap((g) => g.rows)
        .some((r) => r.keys === 'g ,' && r.label === 'Settings'),
    ).toBe(true);
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('the Settings page', () => {
  const wire = (values: Record<string, unknown>): SettingsWire => ({ values, configPath: '/home/me/.work/config.json' });

  it('shows each section, a set one with Reset; a switch saves as it changes; a refused number says why and keeps what you typed', async () => {
    let values: Record<string, unknown> = { 'prWatch.fixCi': false };
    const saveSetting = vi.fn(async (path: string, value: unknown) => {
      if (path === 'sleepIdleAfterMinutes' && value === '3')
        throw new Error('Stop idle agents after (minutes): from 5 to 1440, or 0 for off');
      values = { ...values };
      if (value === null) delete values[path];
      else values[path] = value;
      return wire(values);
    });
    await act(async () => root.render(createElement(SettingsTab, { api: { fetchSettings: async () => wire(values), saveSetting } })));
    await flush();
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'General',
      'Agents & terminals',
      'Pull requests',
      'Reviews',
      'Jira',
      'Time',
      'Archive & usage',
    ]);
    expect(host.textContent).toContain('/home/me/.work/config.json');
    const fixCi = host.querySelector<HTMLInputElement>('#setting-prWatch\\.fixCi')!;
    expect(fixCi.checked).toBe(false);
    // Set by hand: Reset is offered next to it.
    const row = fixCi.closest('.wd-setting')!;
    expect(row.textContent).toContain('Reset');
    await act(async () => fixCi.click());
    expect(saveSetting).toHaveBeenCalledWith('prWatch.fixCi', true);

    const idle = host.querySelector<HTMLInputElement>('#setting-sleepIdleAfterMinutes')!;
    expect(idle.value).toBe('10'); // the default, shown
    await act(async () => typeInto(idle, '3'));
    await act(async () => idle.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await flush();
    expect(saveSetting).toHaveBeenCalledWith('sleepIdleAfterMinutes', '3');
    expect(idle.closest('.wd-setting')!.textContent).toContain('from 5 to 1440');
    expect(idle.value).toBe('3');
  });

  it("an unchanged field isn't saved when you leave it", async () => {
    const saveSetting = vi.fn(async () => wire({}));
    await act(async () => root.render(createElement(SettingsTab, { api: { fetchSettings: async () => wire({}), saveSetting } })));
    await flush();
    const editor = host.querySelector<HTMLInputElement>('#setting-editor')!;
    await act(async () => editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(saveSetting).not.toHaveBeenCalled();
  });
});

describe("a repo's settings", () => {
  const repo = (over: Partial<RepoSettingsWire> = {}): RepoSettingsWire => ({
    alias: 'straumur-backend',
    path: 'C:/src/straumur-backend',
    origin: 'https://github.com/kvika/straumur-backend.git',
    host: 'GitHub',
    requiredChecks: null,
    devCommand: null,
    reviews: null,
    ...over,
  });

  it('says every check counts until some are listed; the list saves one a line', async () => {
    let now = repo();
    const saveRepoSetting = vi.fn(async (_alias: string, key: string, value: unknown) => (now = repo({ [key]: value })));
    await act(async () =>
      root.render(createElement(RepoSettings, { alias: 'straumur-backend', api: { fetchRepoSettings: async () => now, saveRepoSetting } })),
    );
    await flush();
    expect(host.textContent).toContain('every check counts');
    expect(host.textContent).toContain('https://github.com/kvika/straumur-backend.git');
    const checks = host.querySelector<HTMLTextAreaElement>('#repo-straumur-backend-checks')!;
    await act(async () => typeInto(checks, 'Test\nWarning Check\n'));
    await act(async () => checks.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await flush();
    expect(saveRepoSetting).toHaveBeenCalledWith('straumur-backend', 'requiredChecks', ['Test', 'Warning Check']);
    expect(host.textContent).toContain('Now: Test, Warning Check.');
  });
});
