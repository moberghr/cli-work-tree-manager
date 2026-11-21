import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectColorsOf, sessionColor } from '../../../src/core/rail/rail-layout.js';
import { checkRepoSetting, repoSettingsOf } from '../../../src/core/settings/settings-schema.js';

/** A repo's (or group's) colour: its sessions' colour unless one has its own (asked for: a default colour per repo). */
describe('the colour a session shows', () => {
  const layout = {
    places: { own: { color: 'red' as const }, pinned: { pinned: true as const } },
    projectColors: { api: 'blue' as const, shop: 'green' as const },
  };

  it('its own colour wins; else its project’s (a repo, or a group); else none', () => {
    expect(sessionColor(layout, { id: 'own', target: 'api' })).toBe('red');
    expect(sessionColor(layout, { id: 'pinned', target: 'api' })).toBe('blue');
    expect(sessionColor(layout, { id: 'other', target: 'shop' })).toBe('green');
    expect(sessionColor(layout, { id: 'other', target: 'web' })).toBeUndefined();
    expect(sessionColor({ places: {} }, { id: 'x', target: 'api' })).toBeUndefined();
    expect(sessionColor(null, { id: 'x', target: 'api' })).toBeUndefined();
  });

  it('a config’s colours: only names with one of the six', () => {
    expect(projectColorsOf({ api: 'blue', shop: 'teal', web: 3, docs: 'purple' })).toEqual({ api: 'blue', docs: 'purple' });
    expect(projectColorsOf(['blue'])).toEqual({});
    expect(projectColorsOf(null)).toEqual({});
  });
});

describe('a repo’s Colour setting', () => {
  it('takes one of the six or none, and is read from config’s colors by its alias', () => {
    expect(checkRepoSetting('color', 'blue')).toEqual({ ok: true, value: 'blue' });
    expect(checkRepoSetting('color', null)).toEqual({ ok: true, value: null });
    expect(checkRepoSetting('color', 'teal')).toMatchObject({ ok: false, error: expect.stringContaining('red, orange') });
    expect(repoSettingsOf({ colors: { api: 'blue', web: 'teal' } }, 'api').color).toBe('blue');
    expect(repoSettingsOf({ colors: { api: 'blue', web: 'teal' } }, 'web').color).toBeNull();
    expect(repoSettingsOf({}, 'api').color).toBeNull();
  });
});

describe('the rail as it is read', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-color-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('carries each project’s colour from config, and none when config sets none', async () => {
    fs.writeFileSync(
      path.join(home, '.work', 'config.json'),
      JSON.stringify({
        repos: { api: path.join(home, 'api') },
        groups: { shop: ['api'] },
        colors: { api: 'blue', shop: 'green', web: 'teal' },
      }),
    );
    const { readRailLayout } = await import('../../../src/core/rail/rail-store.js');
    expect(readRailLayout().projectColors).toEqual({ api: 'blue', shop: 'green' });
    fs.writeFileSync(path.join(home, '.work', 'config.json'), JSON.stringify({ repos: {}, groups: {} }));
    vi.resetModules();
    const again = await import('../../../src/core/rail/rail-store.js');
    expect('projectColors' in again.readRailLayout()).toBe(false);
  });
});
