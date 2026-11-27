import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeTempFolders,
  claudeTempRoot,
  sessionTempFolders,
  trustedTempRoot,
  type TempFolderIo,
} from '../../../../src/core/agents/claude/temp-folders.js';

/** Where Claude writes a session's scratch files (an artifact's HTML), for the pane beside the terminal. */
describe('claudeTempRoot', () => {
  it('/tmp/claude-<uid> on macOS and Linux (not $TMPDIR), %TEMP%\\claude on Windows', () => {
    expect(claudeTempRoot('darwin', 501, '/var/folders/x/T')).toBe('/tmp/claude-501');
    expect(claudeTempRoot('linux', 1000, '/tmp')).toBe('/tmp/claude-1000');
    expect(claudeTempRoot('win32', -1, 'C:\\Users\\Me\\AppData\\Local\\Temp')).toBe('C:\\Users\\Me\\AppData\\Local\\Temp\\claude');
  });
});

describe('claudeTempFolders', () => {
  // macOS and Linux paths (Windows resolves them onto a drive, and its root is %TEMP%\\claude).
  it.skipIf(process.platform === 'win32')('one per folder its Claude runs in, named as its projects folders are', () => {
    expect(claudeTempFolders({ paths: ['/Users/me/source/repos/work-tree'], isGroup: false }, '/tmp/claude-501')).toEqual([
      '/tmp/claude-501/-Users-me-source-repos-work-tree',
    ]);
  });

  it.skipIf(process.platform === 'win32')('a group: its root and each repo', () => {
    expect(claudeTempFolders({ paths: ['/w/feat-x/api', '/w/feat-x/web'], isGroup: true }, '/tmp/claude-501')).toEqual([
      '/tmp/claude-501/-w-feat-x',
      '/tmp/claude-501/-w-feat-x-api',
      '/tmp/claude-501/-w-feat-x-web',
    ]);
  });
});

/** `/tmp` is everyone's: only a folder of ours that nobody else can write is trusted, and no link is followed. */
describe('sessionTempFolders (real folders)', () => {
  let dir: string;
  let root: string;
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const session = { paths: ['/w/feat-x'], isGroup: false };

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-temp-')));
    root = path.join(dir, 'claude-x');
    fs.mkdirSync(path.join(root, '-w-feat-x'), { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === 'win32')('our own private root: the session folders that exist', () => {
    expect(sessionTempFolders(session, root, process.platform, uid)).toEqual([path.join(root, '-w-feat-x')]);
    expect(sessionTempFolders({ paths: ['/w/other'], isGroup: false }, root, process.platform, uid)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('a parent named through a link counts as where it is (macOS: /tmp is /private/tmp)', () => {
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(dir, alias);
    expect(sessionTempFolders(session, path.join(alias, 'claude-x'), process.platform, uid)).toEqual([path.join(root, '-w-feat-x')]);
  });

  it.skipIf(process.platform === 'win32')('refuses a root others may write or read, or someone else’s', () => {
    fs.chmodSync(root, 0o777);
    expect(sessionTempFolders(session, root, process.platform, uid)).toEqual([]);
    fs.chmodSync(root, 0o750);
    expect(sessionTempFolders(session, root, process.platform, uid)).toEqual([]);
    fs.chmodSync(root, 0o700);
    expect(sessionTempFolders(session, root, process.platform, uid + 1)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a root or a session folder that is a link', () => {
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, '-w-feat-x'), { recursive: true, mode: 0o700 });
    fs.chmodSync(elsewhere, 0o700);
    const linkedRoot = path.join(dir, 'claude-linked');
    fs.symlinkSync(elsewhere, linkedRoot);
    expect(sessionTempFolders(session, linkedRoot, process.platform, uid)).toEqual([]);

    fs.rmSync(path.join(root, '-w-feat-x'), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, '-w-feat-x'), path.join(root, '-w-feat-x'));
    expect(sessionTempFolders(session, root, process.platform, uid)).toEqual([]);
  });

  it('none when there is no root', () => {
    expect(sessionTempFolders(session, path.join(dir, 'missing'), process.platform, uid)).toEqual([]);
  });

  it('on Windows the owner and mode are not asked (its %TEMP% is the user’s own)', () => {
    const io: TempFolderIo = {
      realpath: (p) => p,
      lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: -1, mode: 0o40777 }),
    };
    expect(trustedTempRoot('C:\\Temp\\claude', 'win32', -1, io)).toBe('C:\\Temp\\claude');
    expect(trustedTempRoot('/tmp/claude-1', 'linux', 1, io)).toBeNull();
  });
});
