import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { unwrapStatusLine } from '../../../../src/core/agents/claude/statusline.js';
import { originalStatusLine, userStatusLine } from '../../../../src/core/agents/claude/statusline-run.js';

// work no longer wraps the user's status line (its Claudes carry their own, session-settings.ts): what's left is giving
// back a wrap an older work web left, and the hook finding the user's own line.

const settingsFile = () => path.join(os.homedir(), '.claude', 'settings.json');
const savedFile = () => path.join(os.homedir(), '.work', 'statusline.json');
const writeSettings = (s: unknown) => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s));
};
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;
const readSaved = () => JSON.parse(fs.readFileSync(savedFile(), 'utf-8')) as { original: unknown };
/** What an older work web left: `command` in the settings, `original` saved. */
const oldWrap = (original: Record<string, unknown> | null, command = 'work hook statusline', extra: Record<string, unknown> = {}) => {
  writeSettings({ ...extra, statusLine: { type: 'command', command } });
  fs.mkdirSync(path.dirname(savedFile()), { recursive: true });
  fs.writeFileSync(savedFile(), JSON.stringify({ original }));
};

// One HOME per file: each test starts with nothing saved.
beforeEach(() => fs.rmSync(savedFile(), { force: true }));

describe('unwrapStatusLine (an older work web’s wrap given back)', () => {
  it('puts the original back, with its padding, and deletes the saved copy', async () => {
    const original = { type: 'command', command: 'echo hi', padding: 1 };
    oldWrap(original, 'work hook statusline || (echo hi)');
    expect(await unwrapStatusLine()).toBe('restored');
    expect(readSettings().statusLine).toEqual(original);
    expect(fs.existsSync(savedFile())).toBe(false);
  });

  it('with no original saved (null) removes the status line', async () => {
    oldWrap(null, 'work hook statusline', { model: 'x' });
    expect(await unwrapStatusLine()).toBe('restored');
    expect(readSettings()).toEqual({ model: 'x' });
  });

  it('recognises the hook under another path', async () => {
    oldWrap({ type: 'command', command: 'echo mine' }, 'node /x/dist/bin.js hook statusline');
    expect(await unwrapStatusLine()).toBe('restored');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'echo mine' });
  });

  it('with a damaged saved file leaves the settings as they are, and the file', async () => {
    oldWrap({ type: 'command', command: 'echo mine' });
    fs.writeFileSync(savedFile(), '{broken');
    const before = readSettings();
    expect(await unwrapStatusLine()).toBe('kept');
    expect(readSettings()).toEqual(before);
    expect(fs.readFileSync(savedFile(), 'utf-8')).toBe('{broken');
  });

  it("with no saved file keeps work's status line rather than dropping it", async () => {
    writeSettings({ statusLine: { type: 'command', command: 'work hook statusline' } });
    expect(await unwrapStatusLine()).toBe('kept');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'work hook statusline' });
  });

  it('whose settings write fails keeps the saved original', async () => {
    oldWrap({ type: 'command', command: 'echo mine' });
    fs.writeFileSync(settingsFile(), '{ not json'); // editSettings refuses to replace it
    expect(await unwrapStatusLine()).toBe('failed');
    expect(readSaved().original).toEqual({ type: 'command', command: 'echo mine' });
  });

  it('leaves a status line that is not ours alone, without writing the file', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(settingsFile(), old, old);
    expect(await unwrapStatusLine()).toBe('not-ours');
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'echo mine' });
    expect(Math.abs(fs.statSync(settingsFile()).mtimeMs - old.getTime())).toBeLessThan(1000);
  });
});

describe('userStatusLine (what the hook runs after recording the limits)', () => {
  it('the user’s own line from their settings; none: nothing', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    expect(userStatusLine()).toEqual({ command: 'echo mine' });
    writeSettings({ model: 'x' });
    expect(userStatusLine()).toBeNull();
  });

  it('still wrapped by an older work web: the saved original (never itself)', () => {
    oldWrap({ type: 'command', command: 'echo mine' }, 'work hook statusline || (echo mine)');
    expect(userStatusLine()).toEqual({ command: 'echo mine' });
    expect(originalStatusLine()).toEqual({ command: 'echo mine' });
  });

  it('the project’s local settings, then the project’s, then the user’s', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo user' } });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-proj-'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: 'echo project' } }));
    expect(userStatusLine({ projectDir: project })).toEqual({ command: 'echo project' });
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { command: 'echo local' } }));
    expect(userStatusLine({ projectDir: project })).toEqual({ command: 'echo local' });
    fs.rmSync(project, { recursive: true, force: true });
  });
});
