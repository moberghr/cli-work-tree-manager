import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFile, resolveLinkTarget } from '../../src/core/fs-safe.js';
import { editSettings, editSettingsSync } from '../../src/core/settings-editor.js';

let tmpDir: string;
let claudeDir: string;
let dotfiles: string;
let link: string;
let real: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-settings-test-'));
  claudeDir = path.join(tmpDir, '.claude');
  dotfiles = path.join(tmpDir, '.dotfiles', 'claude', '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(dotfiles, { recursive: true });
  real = path.join(dotfiles, 'settings.json');
  link = path.join(claudeDir, 'settings.json');
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Symlink ~/.claude/settings.json -> the dotfiles copy, stow-style. */
function linkToDotfiles(content: unknown = {}): void {
  fs.writeFileSync(real, JSON.stringify(content, null, 2));
  fs.symlinkSync(path.relative(claudeDir, real), link);
}

describe('resolveLinkTarget', () => {
  it('resolves a symlink to its target', () => {
    linkToDotfiles();
    expect(resolveLinkTarget(link)).toBe(real);
  });

  it('resolves a dangling symlink to where it points', () => {
    fs.symlinkSync(path.relative(claudeDir, real), link);
    expect(resolveLinkTarget(link)).toBe(real);
  });

  it('leaves a plain path alone', () => {
    fs.writeFileSync(link, '{}');
    expect(resolveLinkTarget(link)).toBe(link);
  });

  it('returns the original path for a missing file', () => {
    expect(resolveLinkTarget(link)).toBe(link);
  });

  it('does not follow a symlink cycle', () => {
    const a = path.join(tmpDir, 'a');
    const b = path.join(tmpDir, 'b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(resolveLinkTarget(a)).toBe(a);
  });
});

describe('atomicWriteFile', () => {
  it('writes through a symlink instead of replacing it', () => {
    linkToDotfiles();
    atomicWriteFile(link, 'hello');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('hello');
  });

  it('preserves the existing file mode', () => {
    fs.writeFileSync(link, '{}');
    fs.chmodSync(link, 0o600);
    atomicWriteFile(link, 'x');
    expect(fs.statSync(link).mode & 0o777).toBe(0o600);
  });

  it('leaves no tmp files behind', () => {
    linkToDotfiles();
    atomicWriteFile(link, 'hello');
    expect(fs.readdirSync(dotfiles)).toEqual(['settings.json']);
    expect(fs.readdirSync(claudeDir)).toEqual(['settings.json']);
  });
});

describe('editSettings', () => {
  it('keeps a dotfiles-symlinked settings.json a symlink', async () => {
    linkToDotfiles({ model: 'opus' });
    await editSettings((s) => {
      s.hooks!.Stop = [{ hooks: [{ type: 'command', command: 'work hook stop' }] }];
    });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const written = JSON.parse(fs.readFileSync(real, 'utf8'));
    expect(written.model).toBe('opus');
    expect(written.hooks.Stop).toHaveLength(1);
  });

  it('keeps the symlink on the shutdown (sync) path too', () => {
    linkToDotfiles({ hooks: { Stop: [{ hooks: [] }] } });
    editSettingsSync((s) => { delete s.hooks!.Stop; });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).hooks).toBeUndefined();
  });

  it('creates a plain file when nothing exists yet', async () => {
    await editSettings((s) => { s.hooks!.Stop = []; });
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it('follows a dangling symlink rather than clobbering it', async () => {
    fs.symlinkSync(path.relative(claudeDir, real), link);
    await editSettings((s) => { s.hooks!.Stop = [{ hooks: [] }]; });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(real)).toBe(true);
  });
});
