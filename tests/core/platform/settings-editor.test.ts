import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { atomicWriteFile, resolveLinkTarget } from '../../../src/core/platform/fs-safe.js';
import { editSettings, editSettingsSync } from '../../../src/core/platform/settings-editor.js';

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
    // Windows has no POSIX permission bits — chmod only toggles the read-only
    // attribute and the mode reads back as 0o666 whatever we asked for. Compare
    // against the mode the target actually ended up with, so the invariant
    // under test (the mode survives the rename) holds on both platforms; on
    // POSIX that is still exactly 0o600.
    const before = fs.statSync(link).mode & 0o777;
    atomicWriteFile(link, 'x');
    expect(fs.statSync(link).mode & 0o777).toBe(before);
  });

  it('leaves no tmp files behind', () => {
    linkToDotfiles();
    atomicWriteFile(link, 'hello');
    expect(fs.readdirSync(dotfiles)).toEqual(['settings.json']);
    expect(fs.readdirSync(claudeDir)).toEqual(['settings.json']);
  });

  it('retries a rename Windows refuses while another process has the file open', () => {
    fs.writeFileSync(link, 'old');
    let refusals = 2;
    const rename = vi.fn((from: string, to: string) => {
      if (refusals-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      fs.renameSync(from, to);
    });
    atomicWriteFile(link, 'new', rename);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(link, 'utf8')).toBe('new');
  });

  it('gives up on a rename that keeps failing, and removes its tmp file', () => {
    fs.writeFileSync(link, 'old');
    const always = () => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    };
    expect(() => atomicWriteFile(link, 'new', always)).toThrow('ENOSPC');
    expect(fs.readdirSync(claudeDir)).toEqual(['settings.json']);
    expect(fs.readFileSync(link, 'utf8')).toBe('old');
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
    editSettingsSync((s) => {
      delete s.hooks!.Stop;
    });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).hooks).toBeUndefined();
  });

  it('ends the file with a newline', async () => {
    linkToDotfiles({ model: 'opus' });
    await editSettings((s) => {
      s.hooks!.Stop = [];
    });
    expect(fs.readFileSync(real, 'utf8').endsWith('}\n')).toBe(true);
    editSettingsSync((s) => {
      delete s.hooks;
    });
    expect(fs.readFileSync(real, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('creates a plain file when nothing exists yet', async () => {
    await editSettings((s) => {
      s.hooks!.Stop = [];
    });
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it('follows a dangling symlink rather than clobbering it', async () => {
    fs.symlinkSync(path.relative(claudeDir, real), link);
    await editSettings((s) => {
      s.hooks!.Stop = [{ hooks: [] }];
    });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(real)).toBe(true);
  });
});

describe("never loses the user's settings", () => {
  const file = () => path.join(claudeDir, 'settings.json');
  const addHook = (owner: string) => (s: { hooks?: Record<string, unknown[] | undefined> }) => {
    s.hooks!.Stop = [...(s.hooks!.Stop ?? []), { _workHookOwner: owner, hooks: [{ type: 'command', command: owner }] }];
  };

  it('leaves a settings.json that does not parse untouched (a hand edit with a trailing comma)', async () => {
    const broken = '{\n  "permissions": { "allow": ["Bash(npm test)"] },\n  "model": "opus",\n}\n';
    fs.writeFileSync(file(), broken);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await editSettings(addHook('web'));
    editSettingsSync(addHook('web'));
    expect(fs.readFileSync(file(), 'utf-8')).toBe(broken);
  });

  it('keeps everything that is not ours, and backs the file up before the first edit', async () => {
    const mine = { permissions: { allow: ['Bash(npm test)'] }, model: 'opus', hooks: { Stop: [{ matcher: 'x', hooks: [] }] } };
    fs.writeFileSync(file(), JSON.stringify(mine));
    await editSettings(addHook('web'));
    const after = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    expect(after.permissions).toEqual(mine.permissions);
    expect(after.model).toBe('opus');
    expect(after.hooks.Stop).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(`${file()}.work-backup`, 'utf-8'))).toEqual(mine);
  });

  it('creates the file when there is none', async () => {
    await editSettings(addHook('web'));
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).hooks.Stop).toHaveLength(1);
  });

  it('edits from several processes at once all land (cross-process lock)', async () => {
    fs.writeFileSync(file(), JSON.stringify({ model: 'opus' }));
    const mod = pathToFileURL(path.resolve(__dirname, '../../../src/core/platform/settings-editor.ts')).href;
    const script = path.join(tmpDir, 'edit.mts');
    fs.writeFileSync(
      script,
      `const { editSettings } = await import(${JSON.stringify(mod)});\n` +
        `const owner = process.argv[2];\n` +
        `for (let i = 0; i < 5; i++) await editSettings((s) => { s.hooks.Stop = [...(s.hooks.Stop ?? []), { _workHookOwner: owner + i, hooks: [] }]; });\n`,
    );
    const env = { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir };
    await Promise.all(
      ['a', 'b', 'c', 'd'].map(
        (o) =>
          new Promise<void>((resolve, reject) =>
            execFile(process.execPath, ['--import', 'tsx', script, o], { env, timeout: 60_000 }, (err) => (err ? reject(err) : resolve())),
          ),
      ),
    );
    const after = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    expect(after.model).toBe('opus');
    expect(after.hooks.Stop).toHaveLength(20);
  }, 90_000);
});
