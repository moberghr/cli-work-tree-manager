import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getConfigDir, getConfigPath, loadConfig } from '../../../src/core/platform/config.js';
import {
  checkRepoSetting,
  checkSetting,
  repoSettingsOf,
  setValueAt,
  settingAt,
  SETTINGS,
  SETTING_SECTIONS,
  valueAt,
} from '../../../src/core/settings/settings-schema.js';
import {
  configSettings,
  readRepoSettings,
  readSettings,
  writeRepoSetting,
  writeSetting,
} from '../../../src/core/settings/settings-admin.js';
import { mountSettingsRoutes } from '../../../src/server/routes/settings-routes.js';
import { createDemoSettings, mountDemoSettings } from '../../../src/server/demo/demo-settings.js';
import { DEFAULT_TIME_SETTINGS } from '../../../src/core/time/allocate.js';
import { DEFAULT_TRUSTED_BOTS } from '../../../src/core/pr/pr-review.js';

const field = (p: string) => settingAt(p)!;

describe('the settings schema (pure)', () => {
  it('every field has a known section, a unique path and a default that passes its own check', () => {
    expect(new Set(SETTINGS.map((f) => f.path)).size).toBe(SETTINGS.length);
    for (const f of SETTINGS) {
      expect(SETTING_SECTIONS).toContain(f.section);
      if (f.default !== null) expect(checkSetting(f, f.default)).toMatchObject({ ok: true });
    }
  });

  it("the defaults it shows are the ones work uses (time, trusted bots), so the page doesn't lie", () => {
    expect(field('time.dayHours').default).toBe(DEFAULT_TIME_SETTINGS.dayHours);
    expect(field('time.multiplier').default).toBe(DEFAULT_TIME_SETTINGS.multiplier);
    expect(field('time.capHours').default).toBe(DEFAULT_TIME_SETTINGS.capHours);
    expect(field('time.minHours').default).toBe(DEFAULT_TIME_SETTINGS.minHours);
    expect(field('time.pointsWeight').default).toBe(DEFAULT_TIME_SETTINGS.pointsWeight);
    expect(field('prWatch.trustedBots').default).toEqual([...DEFAULT_TRUSTED_BOTS]);
  });

  it('no secret is ever a setting: a token is named by its environment variable', () => {
    expect(SETTINGS.some((f) => /(^|\.)token$|password|secret/i.test(f.path))).toBe(false);
  });

  it('values are checked and tidied; null is back to the default', () => {
    expect(checkSetting(field('prWatch.fixCi'), 'yes')).toEqual({ ok: false, error: 'on or off' });
    expect(checkSetting(field('sleepIdleAfterMinutes'), '3')).toEqual({ ok: false, error: 'from 5 to 1440, or 0 for off' });
    expect(checkSetting(field('sleepIdleAfterMinutes'), '0')).toEqual({ ok: true, value: 0 });
    expect(checkSetting(field('sleepIdleAfterMinutes'), ' 20 ')).toEqual({ ok: true, value: 20 });
    expect(checkSetting(field('reviews.maxPerDay'), '')).toEqual({ ok: true, value: null }); // empty: no limit
    expect(checkSetting(field('editor'), '  cursor ')).toEqual({ ok: true, value: 'cursor' });
    expect(checkSetting(field('editor'), '   ')).toEqual({ ok: true, value: null });
    expect(checkSetting(field('copyFiles'), [' a.json ', '', 'a.json', '*.{json,env}'])).toEqual({
      ok: true,
      value: ['a.json', '*.{json,env}'],
    });
    expect(checkSetting(field('hostEnv'), ['JAVA_HOME', 'NOT A NAME'])).toEqual({
      ok: false,
      error: "“NOT A NAME” isn't a variable's name",
    });
    expect(checkSetting(field('prWatch.autoArchive'), null)).toEqual({ ok: true, value: null });
  });

  it('a dotted path read and written; taking one out removes the objects it leaves empty', () => {
    const o: Record<string, unknown> = { prWatch: { fixCi: false }, keep: 1 };
    expect(valueAt(o, 'prWatch.fixCi')).toBe(false);
    setValueAt(o, 'time.tempo.accountId', 'abc');
    expect(o.time).toEqual({ tempo: { accountId: 'abc' } });
    setValueAt(o, 'time.tempo.accountId', null);
    expect(o.time).toBeUndefined();
    setValueAt(o, 'prWatch.fixCi', null);
    expect(o).toEqual({ keep: 1 });
    setValueAt(o, 'never.was', null); // nothing to take out: nothing made
    expect(o).toEqual({ keep: 1 });
  });

  it("a repo's settings by its alias; an empty list of checks is none", () => {
    const raw = {
      prWatch: { requiredChecks: { api: ['Test'] } },
      devCommands: { api: 'npm run dev' },
      reviews: { projects: { api: 'off' } },
    };
    expect(repoSettingsOf(raw, 'api')).toEqual({ requiredChecks: ['Test'], devCommand: 'npm run dev', reviews: 'off' });
    expect(repoSettingsOf(raw, 'web')).toEqual({ requiredChecks: null, devCommand: null, reviews: null });
    expect(checkRepoSetting('requiredChecks', [' '])).toEqual({ ok: true, value: null });
    expect(checkRepoSetting('reviews', 'sometimes')).toEqual({ ok: false, error: 'all, asked or off' });
  });
});

let src: string;
beforeAll(() => {
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  fs.mkdirSync(path.join(src, 'api', '.git'), { recursive: true });
  fs.writeFileSync(path.join(src, 'api', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/api.git\n');
});
afterAll(() => fs.rmSync(src, { recursive: true, force: true }));

/** config.json as a user has it: a token, and a setting this code doesn't know. */
function seed() {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({
      worktreesRoot: path.join(src, 'worktrees'),
      repos: { api: path.join(src, 'api') },
      groups: {},
      copyFiles: [],
      jiraWorklog: { site: 'acme.atlassian.net', email: 'me@acme.example', token: 'SECRET-TOKEN' },
      someFutureSetting: { keep: true },
    }),
  );
}
const raw = () => JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;
beforeEach(seed);

describe('settings over config.json', () => {
  it('only the page’s settings are read — never the token beside them', () => {
    const s = readSettings();
    expect(s.values['jiraWorklog.site']).toBe('acme.atlassian.net');
    expect(JSON.stringify(s)).not.toContain('SECRET-TOKEN');
    expect(s.values['prWatch.fixCi']).toBeUndefined(); // not written: its default
  });

  it('a change is written under the lock, unknown keys and the token kept, and work reads it', async () => {
    await writeSetting('prWatch.fixCi', false);
    await writeSetting('sleepIdleAfterMinutes', '20');
    expect(raw()).toMatchObject({ prWatch: { fixCi: false }, sleepIdleAfterMinutes: 20, someFutureSetting: { keep: true } });
    expect((raw().jiraWorklog as { token: string }).token).toBe('SECRET-TOKEN');
    expect(loadConfig()?.prWatch?.fixCi).toBe(false);
    await writeSetting('prWatch.fixCi', null);
    expect(raw().prWatch).toBeUndefined();
  });

  it('refused: a setting not on the page, a value that does not fit, the worktrees folder taken away', async () => {
    await expect(writeSetting('jiraWorklog.token', 'x')).rejects.toMatchObject({ status: 404 });
    await expect(writeSetting('sleepIdleAfterMinutes', 2)).rejects.toThrow(/Stop idle agents after.*from 5 to 1440/);
    await expect(writeSetting('worktreesRoot', '')).rejects.toThrow(/a folder is needed/);
    expect(raw().sleepIdleAfterMinutes).toBeUndefined();
  });

  it("a repo's settings: read with its folder, origin and host; written by alias; an unknown repo refused", async () => {
    expect(readRepoSettings('api')).toMatchObject({
      alias: 'api',
      origin: 'https://github.com/acme/api.git',
      host: 'GitHub',
      requiredChecks: null,
    });
    await writeRepoSetting('api', 'requiredChecks', ['Test', 'Warning Check']);
    await writeRepoSetting('api', 'devCommand', 'npm run dev');
    expect(raw()).toMatchObject({ prWatch: { requiredChecks: { api: ['Test', 'Warning Check'] } }, devCommands: { api: 'npm run dev' } });
    expect(loadConfig()?.prWatch?.requiredChecks).toEqual({ api: ['Test', 'Warning Check'] });
    await writeRepoSetting('api', 'requiredChecks', null);
    expect(raw().prWatch).toBeUndefined();
    expect(() => readRepoSettings('web')).toThrow(/isn't one of your repos/);
    await expect(writeRepoSetting('web', 'devCommand', 'x')).rejects.toMatchObject({ status: 404 });
    await expect(writeRepoSetting('api', 'colour', 'x')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the settings routes: work web’s over config.json, the demo’s in memory, the same answers', () => {
  const apps = () => {
    const events: string[] = [];
    const web = new Hono();
    mountSettingsRoutes(web, { broadcast: (e) => events.push(e), source: configSettings });
    const demo = new Hono();
    mountDemoSettings(
      demo,
      (e) => events.push(e),
      createDemoSettings((a) => (a === 'api' ? '/repos/api' : null)),
    );
    return { events, all: [web, demo] };
  };
  const put = (app: Hono, url: string, body: unknown) =>
    app.request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('a change answers the settings after it and is broadcast; a bad one is 400 with why, an unknown one 404', async () => {
    const { events, all } = apps();
    for (const app of all) {
      const ok = await put(app, '/api/settings', { path: 'prWatch.fixCi', value: false });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { values: Record<string, unknown> }).values['prWatch.fixCi']).toBe(false);
      const bad = await put(app, '/api/settings', { path: 'time.dayHours', value: 40 });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toMatch(/A workday \(hours\): from 0.5 to 24/);
      expect((await put(app, '/api/settings', { path: 'nope', value: 1 })).status).toBe(404);
      expect((await put(app, '/api/settings', { value: 1 })).status).toBe(400);
      const repo = await put(app, '/api/repos/api/settings', { key: 'reviews', value: 'off' });
      expect(((await repo.json()) as { reviews: string }).reviews).toBe('off');
      expect((await app.request('/api/repos/web/settings')).status).toBe(404);
    }
    expect(events.filter((e) => e === 'settings-changed')).toHaveLength(4);
    expect(events).toContain('repos-changed');
  });
});
