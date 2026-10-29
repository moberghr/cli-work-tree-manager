import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { applyStatusLineSetting, unwrapStatusLine, wrapStatusLine, wrapperCommand } from '../../../../src/core/agents/claude/statusline.js';
import { WORK_STATUSLINE, originalStatusLine, shellFor } from '../../../../src/core/agents/claude/statusline-run.js';

const settingsFile = () => path.join(os.homedir(), '.claude', 'settings.json');
const savedFile = () => path.join(os.homedir(), '.work', 'statusline.json');
const writeSettings = (s: unknown) => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s));
};
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;
const readSaved = () => JSON.parse(fs.readFileSync(savedFile(), 'utf-8')) as { original: unknown };

// One HOME per file: each test starts with nothing saved.
beforeEach(() => fs.rmSync(savedFile(), { force: true }));

describe('wrapStatusLine / unwrapStatusLine', () => {
  it('saves the original and puts work in front, keeping padding and refreshInterval', async () => {
    writeSettings({ model: 'x', statusLine: { type: 'command', command: 'echo hi', padding: 2, refreshInterval: 30 } });
    await wrapStatusLine();
    expect(readSettings()).toMatchObject({
      model: 'x',
      statusLine: { type: 'command', command: `${WORK_STATUSLINE} || (echo hi)`, padding: 2, refreshInterval: 30 },
    });
    expect(readSaved().original).toEqual({ type: 'command', command: 'echo hi', padding: 2, refreshInterval: 30 });
    expect(originalStatusLine()).toEqual({ command: 'echo hi' });
  });

  it('wrapping twice keeps the first original', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo hi' } });
    await wrapStatusLine();
    await wrapStatusLine();
    expect(originalStatusLine()).toEqual({ command: 'echo hi' });
  });

  it('wraps again a status line the user replaced, saving the new one', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo one' } });
    await wrapStatusLine();
    writeSettings({ statusLine: { type: 'command', command: 'echo two' } });
    await wrapStatusLine();
    // The fallback follows: a missing work shows the line the user set last.
    expect((readSettings().statusLine as { command: string }).command).toBe(`${WORK_STATUSLINE} || (echo two)`);
    expect(originalStatusLine()).toEqual({ command: 'echo two' });
  });

  it('with no status line saves null and has no fallback; unwrap then removes it', async () => {
    writeSettings({ model: 'x' });
    await wrapStatusLine();
    expect(readSaved().original).toBeNull();
    expect((readSettings().statusLine as { command: string }).command).toBe(WORK_STATUSLINE);
    expect(originalStatusLine()).toBeNull();
    expect(await unwrapStatusLine()).toBe('restored');
    expect(readSettings()).toEqual({ model: 'x' });
    expect(fs.existsSync(savedFile())).toBe(false);
  });

  it('unwrap puts the original back', async () => {
    const original = { type: 'command', command: 'echo hi', padding: 1 };
    writeSettings({ statusLine: original });
    await wrapStatusLine();
    await unwrapStatusLine();
    expect(readSettings().statusLine).toEqual(original);
    expect(fs.existsSync(savedFile())).toBe(false);
  });

  it("wrapping over work's hook under another path keeps the saved original (saving it would make it run itself)", async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    await wrapStatusLine();
    writeSettings({ statusLine: { type: 'command', command: '/usr/bin/work hook statusline', padding: 1 } });
    await wrapStatusLine();
    expect(readSettings().statusLine).toEqual({ type: 'command', command: `${WORK_STATUSLINE} || (echo mine)`, padding: 1 });
    expect(originalStatusLine()).toEqual({ command: 'echo mine' });
  });

  it('wrap leaves an unparsable settings.json alone and saves nothing', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ "statusLine": ');
    await wrapStatusLine();
    expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe('{ "statusLine": ');
    expect(fs.existsSync(savedFile())).toBe(false);
  });

  it('unwrap recognises the hook under another path', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    await wrapStatusLine();
    writeSettings({ statusLine: { type: 'command', command: 'node /x/dist/bin.js hook statusline' } });
    expect(await unwrapStatusLine()).toBe('restored');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'echo mine' });
  });

  it('unwrap with a damaged saved file leaves the settings as they are, and the file', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    await wrapStatusLine();
    fs.writeFileSync(savedFile(), '{broken');
    const before = readSettings();
    expect(await unwrapStatusLine()).toBe('kept');
    expect(readSettings()).toEqual(before);
    expect(fs.readFileSync(savedFile(), 'utf-8')).toBe('{broken');
  });

  it("unwrap with no saved file keeps work's status line rather than dropping it", async () => {
    writeSettings({ statusLine: { type: 'command', command: WORK_STATUSLINE } });
    expect(await unwrapStatusLine()).toBe('kept');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: WORK_STATUSLINE });
  });

  it('unwrap whose settings write fails keeps the saved original', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    await wrapStatusLine();
    fs.writeFileSync(settingsFile(), '{ not json'); // editSettings refuses to replace it
    expect(await unwrapStatusLine()).toBe('failed');
    expect(readSaved().original).toEqual({ type: 'command', command: 'echo mine' });
  });

  it('unwrap leaves a status line that is not ours alone', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    expect(await unwrapStatusLine()).toBe('not-ours');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'echo mine' });
  });
});

describe('applyStatusLineSetting (work web at start, through the adapter)', () => {
  it('a lean server leaves the settings alone', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    expect(await applyStatusLineSetting({ enabled: true, lean: true })).toBe('skipped');
    expect(await applyStatusLineSetting({ enabled: false, lean: true })).toBe('skipped');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'echo mine' });
    expect(fs.existsSync(savedFile())).toBe(false);
  });

  it('wraps by default', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    expect(await applyStatusLineSetting({ enabled: true, lean: false })).toBe('wrapped');
    expect((readSettings().statusLine as { command: string }).command).toBe(wrapperCommand({ command: 'echo mine' }));
    expect(await applyStatusLineSetting({ enabled: true, lean: false })).toBe('wrapped');
  });

  it('usage.statusLine: false gives the original back', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    await applyStatusLineSetting({ enabled: true, lean: false });
    expect(await applyStatusLineSetting({ enabled: false, lean: false })).toBe('restored');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'echo mine' });
  });
});

describe("wrapperCommand: the user's line as the fallback when work is gone", () => {
  it('is the hook alone with no original, else `hook || (theirs)`', () => {
    expect(wrapperCommand(null)).toBe(WORK_STATUSLINE);
    expect(wrapperCommand({ type: 'command', command: '  ' })).toBe(WORK_STATUSLINE);
    expect(wrapperCommand({ type: 'static' })).toBe(WORK_STATUSLINE);
    expect(wrapperCommand({ type: 'command', command: 'echo mine' })).toBe(`${WORK_STATUSLINE} || (echo mine)`);
  });

  it('puts the parenthesis on its own line after a `#` or a newline, which would swallow it', () => {
    expect(wrapperCommand({ command: 'echo mine # my line' })).toBe(`${WORK_STATUSLINE} || (echo mine # my line\n)`);
  });

  // The shell Claude Code uses runs the wrapper; `work` here is a name that isn't on PATH, as after an uninstall.
  const runInShell = (cmd: string) => {
    const sh = shellFor();
    return spawnSync(sh.file, sh.args(cmd.replace(WORK_STATUSLINE, 'work-not-installed-xyz hook statusline')), {
      encoding: 'utf-8',
      windowsHide: true,
    }).stdout;
  };

  it("with work gone, the shell runs the user's own line", () => {
    expect(runInShell(wrapperCommand({ command: 'echo mine' }))).toBe('mine\n');
    expect(runInShell(wrapperCommand({ command: 'echo mine # a comment' }))).toBe('mine\n');
  });

  it('with work there, the right side never runs (its hook exits 0)', () => {
    const sh = shellFor();
    const out = spawnSync(sh.file, sh.args(wrapperCommand({ command: 'echo mine' }).replace(WORK_STATUSLINE, 'true')), {
      encoding: 'utf-8',
      windowsHide: true,
    }).stdout;
    expect(out).toBe('');
  });
});

describe('editing settings that are already as wanted', () => {
  it('wrapping again writes nothing: same content, same mtime', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    await wrapStatusLine();
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(settingsFile(), old, old);
    const before = fs.readFileSync(settingsFile(), 'utf-8');
    await wrapStatusLine();
    expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe(before);
    expect(Math.abs(fs.statSync(settingsFile()).mtimeMs - old.getTime())).toBeLessThan(1000);
  });
});
