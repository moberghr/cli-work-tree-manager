import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Nothing in this file may start a real program: every test injects the openers, and the real ones fail loudly.
vi.mock('../../../src/core/platform/launch.js', () => {
  const never = () => Promise.reject(new Error('a real opener was called'));
  return { startEditor: never, openWithDefaultApp: never, revealInFileManager: never };
});

import {
  openTerminalPath,
  refusedPath,
  resolveTerminalPath,
  VIEWER_EXTENSIONS,
  type OpenTerminalPathDeps,
  type TerminalPathIo,
} from '../../../src/core/worktree/terminal-paths.js';

let tmp: string;
let api: string; // a single repo's worktree
let grp: string; // a group's folder
let backend: string;
let frontend: string;
const listing = new Map<string, string[]>();
const io: TerminalPathIo = { listFiles: async (root) => listing.get(root) ?? [] };

const single = () => ({ paths: [api], isGroup: false });
const group = () => ({ paths: [backend, frontend], isGroup: true });
const real = (...p: string[]) => fs.realpathSync.native(path.join(...p));

function write(file: string, text = 'x\n'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-paths-'));
  api = path.join(tmp, 'api');
  const apiFiles = [
    'src/cart.ts',
    'src/web/src/components/Dashboard/SessionRail.tsx',
    'README.md',
    'run.sh',
    'tools/deploy.command',
    'bin/setup.exe',
    'Makefile',
    'mock.html',
    'Thing.app/Contents/Info.plist',
  ];
  for (const f of apiFiles) write(path.join(api, f));
  // Links: the name says html, the file is a script; the name says txt, the file is a page.
  fs.symlinkSync(path.join(api, 'run.sh'), path.join(api, 'notes.html'));
  fs.symlinkSync(path.join(api, 'mock.html'), path.join(api, 'x.txt'));
  listing.set(api, [...apiFiles, 'notes.html', 'x.txt']);

  grp = path.join(tmp, 'grp', 'feat');
  backend = path.join(grp, 'backend');
  frontend = path.join(grp, 'frontend');
  write(path.join(grp, 'README.md'));
  for (const repo of [backend, frontend]) {
    write(path.join(repo, 'src', 'server.ts'));
    write(path.join(repo, 'README.md'));
  }
  write(path.join(frontend, 'src', 'App.tsx'));
  listing.set(backend, ['README.md', 'src/server.ts']);
  listing.set(frontend, ['README.md', 'src/App.tsx', 'src/server.ts']);

  // This test file's own temp HOME (tests/setup/isolate-home.ts).
  write(path.join(os.homedir(), 'notes', 'today.md'));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('resolveTerminalPath: where a path is', () => {
  it('an absolute path as it is, by its real path, with its line', async () => {
    expect(await resolveTerminalPath(single(), `${api}/src/cart.ts:12`, io)).toEqual({
      raw: `${api}/src/cart.ts:12`,
      path: real(api, 'src/cart.ts'),
      kind: 'file',
      opens: 'editor',
      line: 12,
    });
  });

  it('a file:// address is the path it names', async () => {
    const r = await resolveTerminalPath(single(), pathToFileURL(path.join(api, 'mock.html')).href, io);
    expect(r).toMatchObject({ path: real(api, 'mock.html'), kind: 'file', opens: 'app' });
  });

  it('~ is the home folder', async () => {
    expect(await resolveTerminalPath(single(), '~/notes/today.md', io)).toMatchObject({
      path: real(os.homedir(), 'notes', 'today.md'),
      kind: 'file',
      opens: 'editor',
    });
    expect(await resolveTerminalPath(single(), '~', io)).toMatchObject({ path: real(os.homedir()), kind: 'dir', opens: 'reveal' });
  });

  it("a relative path against a single repo's worktree", async () => {
    expect(await resolveTerminalPath(single(), 'src/cart.ts', io)).toMatchObject({ path: real(api, 'src/cart.ts'), kind: 'file' });
    expect(await resolveTerminalPath(single(), './src/cart.ts:3:9', io)).toMatchObject({ path: real(api, 'src/cart.ts'), line: 3 });
  });

  it('a group: its own folder first, then each repo in turn', async () => {
    // The group folder has a README.md of its own: that one, not a repo's.
    expect((await resolveTerminalPath(group(), 'README.md', io)).path).toBe(real(grp, 'README.md'));
    expect((await resolveTerminalPath(group(), 'frontend/src/App.tsx', io)).path).toBe(real(frontend, 'src/App.tsx'));
    // In both repos: the first repo's.
    expect((await resolveTerminalPath(group(), 'src/server.ts', io)).path).toBe(real(backend, 'src/server.ts'));
    expect((await resolveTerminalPath(group(), 'src/App.tsx', io)).path).toBe(real(frontend, 'src/App.tsx'));
  });

  it('a bare name: one listed file of that name is it', async () => {
    expect(await resolveTerminalPath(single(), 'SessionRail.tsx:202', io)).toEqual({
      raw: 'SessionRail.tsx:202',
      path: real(api, 'src/web/src/components/Dashboard/SessionRail.tsx'),
      kind: 'file',
      opens: 'editor',
      line: 202,
    });
  });

  it('a bare name several listed files have is ambiguous: the code search, no path', async () => {
    expect(await resolveTerminalPath(group(), 'server.ts', io)).toEqual({
      raw: 'server.ts',
      path: null,
      kind: 'ambiguous',
      opens: 'search',
    });
  });

  it('a bare name no listed file has is missing', async () => {
    expect(await resolveTerminalPath(group(), 'Nope.tsx', io)).toEqual({ raw: 'Nope.tsx', path: null, kind: 'missing', opens: null });
  });

  it('the end of a listed path finds that file (a path printed from inside a folder)', async () => {
    expect(await resolveTerminalPath(single(), 'Dashboard/SessionRail.tsx:7', io)).toMatchObject({
      path: real(api, 'src/web/src/components/Dashboard/SessionRail.tsx'),
      line: 7,
    });
    // Only whole segments: `Rail.tsx` is not the end of `SessionRail.tsx`.
    expect((await resolveTerminalPath(single(), 'Dashboard/Rail.tsx', io)).kind).toBe('missing');
    expect((await resolveTerminalPath(single(), '../Dashboard/SessionRail.tsx', io)).kind).toBe('missing');
  });

  it('the real path decides the type: a notes.html linking to a script is for the editor, an x.txt linking to a page for the app', async () => {
    expect(await resolveTerminalPath(single(), 'notes.html', io)).toMatchObject({
      path: real(api, 'run.sh'),
      kind: 'file',
      opens: 'editor',
    });
    expect(await resolveTerminalPath(single(), 'x.txt', io)).toMatchObject({ path: real(api, 'mock.html'), kind: 'file', opens: 'app' });
  });

  it('viewer types open with the app; anything else with the editor; a folder, a .app included, is revealed', async () => {
    expect([...VIEWER_EXTENSIONS].sort()).toEqual(['gif', 'htm', 'html', 'jpeg', 'jpg', 'pdf', 'png', 'svg', 'webp']);
    for (const f of ['run.sh', 'tools/deploy.command', 'bin/setup.exe', 'Makefile', 'README.md']) {
      expect((await resolveTerminalPath(single(), f, io)).opens).toBe('editor');
    }
    expect(await resolveTerminalPath(single(), 'Thing.app:5', io)).toEqual({
      raw: 'Thing.app:5',
      path: real(api, 'Thing.app'),
      kind: 'dir',
      opens: 'reveal',
    });
    expect(await resolveTerminalPath(single(), `${api}/src`, io)).toMatchObject({ kind: 'dir', opens: 'reveal' });
  });

  it('a line past the limit is dropped', async () => {
    const r = await resolveTerminalPath(single(), 'src/cart.ts:99999999', io);
    expect(r.kind).toBe('file');
    expect(r).not.toHaveProperty('line');
  });

  it('missing is an answer, never a throw', async () => {
    const failing: TerminalPathIo = { listFiles: () => Promise.reject(new Error('git broke')) };
    for (const raw of [`${tmp}/nope/here.ts`, 'C:\\nope\\x.ts', 'a\0b.ts', 'Gone.tsx', 'src/gone/x.ts', ':12']) {
      expect(await resolveTerminalPath(single(), raw, failing)).toEqual({ raw, path: null, kind: 'missing', opens: null });
    }
  });
});

describe('openTerminalPath: what a click starts', () => {
  const started = {
    startEditor: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
    openWithDefaultApp: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
    revealInFileManager: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
  };
  const deps: OpenTerminalPathDeps = { ...started, io };
  beforeEach(() => Object.values(started).forEach((f) => f.mockClear()));

  it('default on a script, a .command, an .exe or a file with no extension: the editor, never the default app (SC4)', async () => {
    for (const f of ['run.sh', 'tools/deploy.command', 'bin/setup.exe', 'Makefile', 'notes.html']) {
      started.startEditor.mockClear();
      const r = await openTerminalPath(single(), f, 'default', deps);
      expect(r).toEqual({ ok: true, opened: real(api, f === 'notes.html' ? 'run.sh' : f) });
      expect(started.startEditor).toHaveBeenCalledWith(api, { path: real(api, f === 'notes.html' ? 'run.sh' : f) });
    }
    expect(started.openWithDefaultApp).not.toHaveBeenCalled();
    expect(started.revealInFileManager).not.toHaveBeenCalled();
  });

  it('default on a .app folder: revealed only', async () => {
    expect(await openTerminalPath(single(), 'Thing.app', 'default', deps)).toEqual({ ok: true, opened: real(api, 'Thing.app') });
    expect(started.revealInFileManager).toHaveBeenCalledWith(real(api, 'Thing.app'));
    expect(started.openWithDefaultApp).not.toHaveBeenCalled();
    expect(started.startEditor).not.toHaveBeenCalled();
  });

  it('default on a page: the default app; Open in editor: the editor; Reveal: the file manager', async () => {
    await openTerminalPath(single(), 'mock.html', 'default', deps);
    expect(started.openWithDefaultApp).toHaveBeenCalledWith(real(api, 'mock.html'));
    await openTerminalPath(single(), 'mock.html', 'editor', deps);
    expect(started.startEditor).toHaveBeenCalledWith(api, { path: real(api, 'mock.html') });
    await openTerminalPath(single(), 'src/cart.ts', 'reveal', deps);
    expect(started.revealInFileManager).toHaveBeenCalledWith(real(api, 'src/cart.ts'));
    expect(started.openWithDefaultApp).toHaveBeenCalledTimes(1);
  });

  it("the editor at the line, in the session's window; a file outside it in its own folder's", async () => {
    await openTerminalPath(single(), 'src/cart.ts:42', 'default', deps);
    expect(started.startEditor).toHaveBeenLastCalledWith(api, { path: real(api, 'src/cart.ts'), line: 42 });
    await openTerminalPath(group(), 'backend/src/server.ts:3', 'editor', deps);
    expect(started.startEditor).toHaveBeenLastCalledWith(grp, { path: real(backend, 'src/server.ts'), line: 3 });
    await openTerminalPath(single(), '~/notes/today.md', 'default', deps);
    expect(started.startEditor).toHaveBeenLastCalledWith(real(os.homedir(), 'notes'), { path: real(os.homedir(), 'notes', 'today.md') });
  });

  it('missing or ambiguous: that error, and nothing starts', async () => {
    expect(await openTerminalPath(single(), 'Gone.tsx', 'default', deps)).toEqual({ error: 'missing' });
    expect(await openTerminalPath(group(), 'server.ts', 'editor', deps)).toEqual({ error: 'ambiguous' });
    for (const f of Object.values(started)) expect(f).not.toHaveBeenCalled();
  });

  it('resolves again: a file deleted after it was found is missing', async () => {
    const file = path.join(api, 'scratch.html');
    write(file);
    expect((await resolveTerminalPath(single(), file, io)).kind).toBe('file');
    fs.rmSync(file);
    expect(await openTerminalPath(single(), file, 'default', deps)).toEqual({ error: 'missing' });
    for (const f of Object.values(started)) expect(f).not.toHaveBeenCalled();
  });

  it('a program that could not start is a failure with its reason', async () => {
    started.startEditor.mockResolvedValueOnce('could not start code: spawn code ENOENT');
    expect(await openTerminalPath(single(), 'README.md', 'default', deps)).toEqual({
      error: 'failed',
      message: 'could not start code: spawn code ENOENT',
    });
  });
});

describe('refusedPath: paths never looked at', () => {
  it('another machine: a file:// host, or two leading separators', () => {
    expect(refusedPath('file://attacker/share/a.png', '/share/a.png')).toBe(true);
    expect(refusedPath('file:////attacker/share/a.png', '//attacker/share/a.png')).toBe(true);
    expect(refusedPath('\\\\attacker\\share\\a.png', '\\\\attacker\\share\\a.png')).toBe(true);
    expect(refusedPath('//attacker/share/a.png', '//attacker/share/a.png')).toBe(true);
    expect(refusedPath('\\\\?\\C:\\x.html', '\\\\?\\C:\\x.html')).toBe(true);
  });

  it('this machine: no host, or localhost', () => {
    expect(refusedPath('file:///tmp/a.html', '/tmp/a.html')).toBe(false);
    expect(refusedPath('file://localhost/tmp/a.html', '/tmp/a.html')).toBe(false);
    expect(refusedPath('src/a.ts:10', 'src/a.ts')).toBe(false);
  });

  it('on Windows, a colon after the drive letter (an alternate stream)', () => {
    expect(refusedPath('C:\\x\\a.txt:x.html', 'C:\\x\\a.txt:x.html', 'win32')).toBe(true);
    expect(refusedPath('C:\\x\\a.txt', 'C:\\x\\a.txt', 'win32')).toBe(false);
    expect(refusedPath('a.txt:x.html', 'a.txt:x.html', 'darwin')).toBe(false);
  });

  it('a network path resolves as missing without being looked at', async () => {
    const r = await resolveTerminalPath({ paths: [api], isGroup: false }, 'file://attacker/share/a.png');
    expect(r).toEqual({ raw: 'file://attacker/share/a.png', path: null, kind: 'missing', opens: null });
    expect((await resolveTerminalPath({ paths: [api], isGroup: false }, '//attacker/share/a.png')).kind).toBe('missing');
  });
});

describe('resolveTerminalPath: refused paths are never looked at', () => {
  it('a file:// host, two leading slashes and two leading backslashes: missing, and no stat or realpath', async () => {
    const realpath = vi.spyOn(fs.realpathSync, 'native');
    const stat = vi.spyOn(fs, 'statSync');
    try {
      for (const raw of ['file://attacker/share/a.png', '//h/s/a.png', '\\\\h\\s\\a.png']) {
        expect(await resolveTerminalPath(single(), raw, io)).toEqual({ raw, path: null, kind: 'missing', opens: null });
      }
      expect(realpath).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
      stat.mockRestore();
    }
  });

  it('file://localhost is this machine: the file resolves and opens with the app', async () => {
    const r = await resolveTerminalPath(single(), `file://localhost${path.join(api, 'mock.html')}`, io);
    expect(r).toMatchObject({ path: real(api, 'mock.html'), kind: 'file', opens: 'app' });
  });
});

describe('resolveTerminalPath: extensions and links', () => {
  let dir: string;
  beforeAll(() => {
    dir = path.join(tmp, 'kinds');
    for (const f of ['UP.HTML', 'Pic.PNG', 'run.SH']) write(path.join(dir, f));
    fs.mkdirSync(path.join(dir, 'folder'));
    fs.symlinkSync(path.join(dir, 'folder'), path.join(dir, 'link.html'));
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'dangling.html'));
  });
  const at = (f: string) => resolveTerminalPath(single(), path.join(dir, f), io);

  it('the extension is judged in lower case', async () => {
    expect((await at('UP.HTML')).opens).toBe('app');
    expect((await at('Pic.PNG')).opens).toBe('app');
    expect((await at('run.SH')).opens).toBe('editor');
  });

  it('a link named .html that points to a folder is a folder to reveal', async () => {
    expect(await at('link.html')).toMatchObject({ path: real(dir, 'folder'), kind: 'dir', opens: 'reveal' });
  });

  it('a dangling link is missing', async () => {
    expect((await at('dangling.html')).kind).toBe('missing');
  });
});

describe('openTerminalPath: folders, editor windows and failures', () => {
  const started = {
    startEditor: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
    openWithDefaultApp: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
    revealInFileManager: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
  };
  const deps: OpenTerminalPathDeps = { ...started, io };
  beforeEach(() => Object.values(started).forEach((f) => f.mockClear()));

  it('how editor on a folder reveals it: the editor is not started', async () => {
    expect(await openTerminalPath(single(), `${api}/src`, 'editor', deps)).toEqual({ ok: true, opened: real(api, 'src') });
    expect(started.revealInFileManager).toHaveBeenCalledWith(real(api, 'src'));
    expect(started.startEditor).not.toHaveBeenCalled();
  });

  it("a file in a sibling folder that shares the worktree's name as a prefix gets its own folder's window", async () => {
    const file = path.join(tmp, 'api2', 'x.ts');
    write(file);
    await openTerminalPath(single(), file, 'editor', deps);
    expect(started.startEditor).toHaveBeenCalledWith(real(tmp, 'api2'), { path: real(file) });
  });

  it("a failing file manager's or default app's reason reaches the result", async () => {
    started.revealInFileManager.mockResolvedValueOnce('open failed (exit code 1)');
    expect(await openTerminalPath(single(), 'README.md', 'reveal', deps)).toEqual({
      error: 'failed',
      message: 'open failed (exit code 1)',
    });
    started.openWithDefaultApp.mockResolvedValueOnce('could not start xdg-open: ENOENT');
    expect(await openTerminalPath(single(), 'mock.html', 'default', deps)).toEqual({
      error: 'failed',
      message: 'could not start xdg-open: ENOENT',
    });
  });
});
