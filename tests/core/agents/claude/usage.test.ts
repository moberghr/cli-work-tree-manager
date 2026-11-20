import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { claudeUsage, restoreMessage } from '../../../../src/core/agents/claude/usage.js';
import { recordReading } from '../../../../src/core/usage/usage-store.js';

const settingsFile = () => path.join(os.homedir(), '.claude', 'settings.json');
const savedFile = () => path.join(os.homedir(), '.work', 'statusline.json');
const writeSettings = (s: unknown) => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s));
};
const statusLine = () => (JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as { statusLine?: { command?: string } }).statusLine;

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.work'), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true });
});

describe("Claude's usage source", () => {
  it('reads what the status-line hook recorded, per account', () => {
    recordReading('claude', 'default', [{ id: 'five_hour', label: '5-hour limit', usedPercent: 12, resetsAt: null }]);
    expect(claudeUsage.read()).toMatchObject([{ account: 'default', windows: [{ id: 'five_hour', usedPercent: 12 }] }]);
  });

  /** What an older work web left: the line wrapped, the original saved. */
  const oldWrap = () => {
    writeSettings({ statusLine: { type: 'command', command: 'work hook statusline || (echo mine)' } });
    fs.mkdirSync(path.dirname(savedFile()), { recursive: true });
    fs.writeFileSync(savedFile(), JSON.stringify({ original: { type: 'command', command: 'echo mine' } }));
  };

  it('setup gives back a status line an older work web wrapped; settings with none of it are left alone', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    expect(await claudeUsage.setup!({ enabled: true, lean: false })).toBe("status line: nothing of work's in your settings");
    expect(statusLine()).toEqual({ type: 'command', command: 'echo mine' });
    oldWrap();
    expect(await claudeUsage.setup!({ enabled: true, lean: true })).toMatch(/given back in default/);
    expect(statusLine()).toEqual({ type: 'command', command: 'echo mine' });
  });

  it('restore: back, not ours (both fine), or kept with the saved copy damaged (not fine)', async () => {
    oldWrap();
    expect(await claudeUsage.restore!()).toEqual({ ok: true, message: restoreMessage('restored') });
    expect(await claudeUsage.restore!()).toEqual({ ok: true, message: restoreMessage('not-ours') });

    oldWrap();
    fs.writeFileSync(savedFile(), '{broken');
    expect(await claudeUsage.restore!()).toEqual({ ok: false, message: restoreMessage('kept') });
  });

  it('restore with settings that do not parse fails, and says so', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ not json');
    expect(await claudeUsage.restore!()).toEqual({ ok: false, message: restoreMessage('failed') });
  });
});

describe('restoreMessage', () => {
  it('says what happened for each outcome', () => {
    expect(restoreMessage('restored')).toContain('Your own status line is back');
    expect(restoreMessage('not-ours')).toContain("isn't work's");
    expect(restoreMessage('kept')).toContain('statusline.json');
    expect(restoreMessage('kept')).toContain('/statusline');
    expect(restoreMessage('failed')).toContain("couldn't be changed");
  });
});
