import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getConfigDir, getConfigPath, isAgentId, loadConfig } from '../../../src/core/platform/config.js';
import {
  checkRepoSetting,
  checkSetting,
  repoSettingsOf,
  setValueAt,
  settingAt,
  SETTINGS,
  SETTING_PATTERNS,
  SETTING_SECTIONS,
  valueAt,
} from '../../../src/core/settings/settings-schema.js';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_LINE_HEIGHT,
  DEFAULT_TERMINAL_THEME,
  TERMINAL_FONT_PATTERN,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_LINE_HEIGHT_RANGE,
  TERMINAL_THEMES,
} from '../../../src/core/settings/terminal-style.js';
import { originShown, readRepoSettings, readSettings, writeRepoSetting, writeSetting } from '../../../src/core/settings/settings-admin.js';
import { DEFAULT_TIME_SETTINGS } from '../../../src/core/time/allocate.js';
import { DEFAULT_TRUSTED_BOTS } from '../../../src/core/pr/pr-review.js';
import { isIssueKey } from '../../../src/core/time/allocate.js';

const field = (p: string) => settingAt(p)!;

describe('the settings schema (pure)', () => {
  it('every field has a known section, a unique path and a default that passes its own check', () => {
    expect(new Set(SETTINGS.map((f) => f.path)).size).toBe(SETTINGS.length);
    for (const f of SETTINGS) {
      expect(SETTING_SECTIONS).toContain(f.section);
      if (f.default !== null) expect(checkSetting(f, f.default)).toMatchObject({ ok: true });
    }
  });

  it('the Terminal fields are the terminal module’s: its defaults, ranges, themes and font rule', () => {
    expect(field('terminal.theme').section).toBe('Terminal');
    expect(field('terminal.theme').default).toBe(DEFAULT_TERMINAL_THEME);
    expect(field('terminal.theme').kind).toEqual({
      type: 'choice',
      options: TERMINAL_THEMES.map((t) => ({ value: t.id, label: t.label })),
    });
    expect(field('terminal.fontSize').default).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(field('terminal.fontSize').kind).toEqual({ type: 'number', ...TERMINAL_FONT_SIZE_RANGE });
    expect(field('terminal.lineHeight').default).toBe(DEFAULT_TERMINAL_LINE_HEIGHT);
    expect(field('terminal.lineHeight').kind).toEqual({ type: 'number', ...TERMINAL_LINE_HEIGHT_RANGE });
    expect(field('terminal.fontFamily').default).toBeNull();
    expect(SETTING_PATTERNS.fontFamily).toBe(TERMINAL_FONT_PATTERN);
  });

  it('the terminal’s font size and font name are checked', () => {
    expect(checkSetting(field('terminal.fontSize'), 40)).toMatchObject({ ok: false });
    expect(checkSetting(field('terminal.fontFamily'), 'Hack; color: red')).toMatchObject({ ok: false });
    expect(checkSetting(field('terminal.fontFamily'), 'JetBrains Mono, Hack')).toMatchObject({ ok: true });
  });

  it("the defaults it shows are the ones work uses (time, trusted bots), so the page doesn't lie", () => {
    expect(field('time.dayHours').default).toBe(DEFAULT_TIME_SETTINGS.dayHours);
    expect(field('time.multiplier').default).toBe(DEFAULT_TIME_SETTINGS.multiplier);
    expect(field('time.capHours').default).toBe(DEFAULT_TIME_SETTINGS.capHours);
    expect(field('time.minHours').default).toBe(DEFAULT_TIME_SETTINGS.minHours);
    expect(field('time.pointsWeight').default).toBe(DEFAULT_TIME_SETTINGS.pointsWeight);
    expect(field('prWatch.trustedBots').default).toEqual([...DEFAULT_TRUSTED_BOTS]);
    // The PTY host keeps nothing unless config names it (pty-registry.ts: `hostEnv ?? []`).
    expect(field('hostEnv').default).toEqual([]);
  });

  it("what the page accepts is what config.ts keeps: each field's rule is its reader's", () => {
    const ok = (p: string, v: unknown) => checkSetting(field(p), v).ok;
    for (const k of ['SSD-1', 'PAY-12', 'pay-1', 'SSD', 'S-1', 'TOOLONGPROJECT-1'])
      expect([k, ok('time.gapTicket', k)]).toEqual([k, isIssueKey(k)]);
    expect(ok('time.timeOffTicket', 'HR')).toBe(false);
    expect(ok('time.projects', ['PAY', 'SSD'])).toBe(true);
    expect(checkSetting(field('time.projects'), ['pay'])).toEqual({ ok: false, error: "“pay” isn't a Jira project key (PAY)" });
    expect(ok('time.storyPointsField', 'customfield_10016')).toBe(true);
    expect(ok('time.storyPointsField', 'Story Points')).toBe(false);
    for (const a of ['claude', 'my-agent.v2', 'node my.js', '../x']) expect([a, ok('internalAgent', a)]).toEqual([a, isAgentId(a)]);
  });

  it('the worktrees folder can never be left empty (no Reset); archive compression may be 0 (never)', () => {
    expect(field('worktreesRoot').required).toBe(true);
    expect(checkSetting(field('worktreesRoot'), null)).toEqual({ ok: false, error: 'it can’t be left empty' });
    expect(checkSetting(field('worktreesRoot'), '  ')).toEqual({ ok: false, error: 'it can’t be left empty' });
    expect(checkSetting(field('archive.compressAfterDays'), 0)).toEqual({ ok: true, value: 0 });
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
      reviews: { projects: { api: 'off' }, focusFor: { api: ['A migration has a way back', 7], web: [] } },
    };
    expect(repoSettingsOf(raw, 'api')).toEqual({
      requiredChecks: ['Test'],
      devCommand: 'npm run dev',
      reviews: 'off',
      reviewFocus: ['A migration has a way back'],
      color: null,
    });
    expect(repoSettingsOf(raw, 'web')).toEqual({ requiredChecks: null, devCommand: null, reviews: null, reviewFocus: null, color: null });
    // What a repo's reviews pay attention to: a list, an empty one is none.
    expect(checkRepoSetting('reviewFocus', ['Card data is never logged'])).toEqual({ ok: true, value: ['Card data is never logged'] });
    expect(checkRepoSetting('reviewFocus', [' '])).toEqual({ ok: true, value: null });
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

  it('the terminal’s hand-written colours leave config.json, only the ones that fit', () => {
    const cfg = raw();
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        ...cfg,
        terminal: {
          colors: { background: '#000', red: 'red', bogus: '#fff', selectionBackground: '#00ff0080', green: '#00ff0080', blue: 4 },
        },
      }),
    );
    expect(readSettings().terminalColors).toEqual({ background: '#000', selectionBackground: '#00ff0080' });
  });

  it('no terminalColors when terminal.colors is absent or has nothing that fits', () => {
    expect('terminalColors' in readSettings()).toBe(false);
    fs.writeFileSync(getConfigPath(), JSON.stringify({ ...raw(), terminal: { colors: { bogus: '#fff', red: 'nope' } } }));
    expect('terminalColors' in readSettings()).toBe(false);
    fs.writeFileSync(getConfigPath(), JSON.stringify({ ...raw(), terminal: { colors: ['#fff'] } }));
    expect('terminalColors' in readSettings()).toBe(false);
  });

  it('a Terminal setting saved or reset keeps the hand-written colours beside it', async () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({ ...raw(), terminal: { colors: { background: '#000' } } }));
    await writeSetting('terminal.theme', 'dracula');
    await writeSetting('terminal.fontSize', 16);
    expect(raw().terminal).toEqual({ colors: { background: '#000' }, theme: 'dracula', fontSize: 16 });
    expect(readSettings()).toMatchObject({
      values: { 'terminal.theme': 'dracula', 'terminal.fontSize': 16 },
      terminalColors: { background: '#000' },
    });
    expect(loadConfig()?.terminal).toEqual({ theme: 'dracula', fontSize: 16, colors: { background: '#000' } });

    await writeSetting('terminal.theme', null);
    await writeSetting('terminal.fontSize', null);
    expect(raw().terminal).toEqual({ colors: { background: '#000' } });
    expect(readSettings().terminalColors).toEqual({ background: '#000' });
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
    await expect(writeSetting('worktreesRoot', '')).rejects.toThrow(/can’t be left empty/);
    expect(raw().sleepIdleAfterMinutes).toBeUndefined();
  });

  it('the folders as `work init` takes them: ~ expanded, full paths only, the worktrees folder made', async () => {
    await writeSetting('worktreesRoot', '~/wt-from-settings');
    expect(raw().worktreesRoot).toBe(path.join(os.homedir(), 'wt-from-settings'));
    expect(fs.existsSync(path.join(os.homedir(), 'wt-from-settings'))).toBe(true);
    await expect(writeSetting('worktreesRoot', 'relative/wt')).rejects.toThrow(/isn't a full path/);
    await writeSetting('scanRoots', ['~']);
    expect(raw().scanRoots).toEqual([os.homedir()]);
    await expect(writeSetting('scanRoots', ['some/where'])).rejects.toThrow(/isn't a full path/);
    await expect(writeSetting('scanRoots', [path.join(src, 'nope')])).rejects.toThrow(/isn't a folder/);
  });

  it('the Jira watch’s daily limit, once saved, is what the watch reads', async () => {
    await writeSetting('jiraWatch.maxPerDay', 2);
    expect(loadConfig()?.jiraWatch).toEqual({ maxPerDay: 2 });
  });

  it("an origin's sign-in is never shown; `constructor` is no repo and no setting", async () => {
    expect(originShown('https://me:ghp_SECRET@github.com/acme/api.git')).toBe('https://github.com/acme/api.git');
    expect(originShown('git@github.com:acme/api.git')).toBe('git@github.com:acme/api.git');
    expect(originShown(null)).toBeNull();
    expect(() => readRepoSettings('constructor')).toThrow(/isn't one of your repos/);
    await expect(writeRepoSetting('constructor', 'reviews', 'off')).rejects.toMatchObject({ status: 404 });
    await expect(writeRepoSetting('api', 'toString', 'x')).rejects.toMatchObject({ status: 404 });
    expect(raw().reviews).toBeUndefined();
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
