import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShownFiles,
  findTempFile,
  readShownFile,
  imageType,
  insideFolders,
  locateInSession,
  shownKind,
} from '../../../src/core/sessions/shown-file.js';

/** A file a session shows beside its terminal (asked for: a spec to approve had to be read in another tab). */
describe('shownKind', () => {
  it('Markdown is rendered, an image is drawn, the rest is text; an SVG is text (it could carry a script)', () => {
    expect(shownKind('docs/specs/2026-11-18-thing.md')).toBe('markdown');
    expect(shownKind('README.MARKDOWN')).toBe('markdown');
    expect(shownKind('shot.PNG')).toBe('image');
    expect(shownKind('a/b/photo.jpeg')).toBe('image');
    expect(shownKind('logo.svg')).toBe('text');
    // An artifact's HTML: drawn in a sandboxed frame.
    expect(shownKind('dashboard.html')).toBe('html');
    expect(shownKind('old/Page.HTM')).toBe('html');
    expect(shownKind('src/app.ts')).toBe('text');
    expect(shownKind('Makefile')).toBe('text');
    expect(imageType('shot.png')).toBe('image/png');
    expect(imageType('a.jpg')).toBe('image/jpeg');
    expect(imageType('logo.svg')).toBeNull();
    expect(imageType('notes.md')).toBeNull();
  });
});

describe('locateInSession', () => {
  const single = { paths: ['/wt/api'], isGroup: false };
  const group = { paths: ['/wt/feat-x/api', '/wt/feat-x/web'], isGroup: true };

  it('a file in one of its repos: the repo’s folder name and the path under it', () => {
    expect(locateInSession(single, '/wt/api/docs/specs/a.md')).toEqual({ repo: 'api', path: 'docs/specs/a.md' });
    expect(locateInSession(group, '/wt/feat-x/web/src/page.tsx')).toEqual({ repo: 'web', path: 'src/page.tsx' });
    expect(locateInSession(single, '\\wt\\api\\docs\\a.md'.replace(/\\/g, '/'))).toEqual({ repo: 'api', path: 'docs/a.md' });
  });

  it('a session folder’s own file is repo ""; one in a subfolder that is no repo isn’t its', () => {
    expect(locateInSession(group, '/wt/feat-x/CLAUDE.md')).toEqual({ repo: '', path: 'CLAUDE.md' });
    expect(locateInSession(group, '/wt/feat-x/notes/a.md')).toBeNull();
    // A single repo has no folder of its own beside it.
    expect(locateInSession(single, '/wt/other.md')).toBeNull();
  });

  it('none of its folders: no; a folder that only starts the same isn’t it; the folder itself is no file', () => {
    expect(locateInSession(single, '/etc/passwd')).toBeNull();
    expect(locateInSession(single, '/wt/api-secrets/key.pem')).toBeNull();
    expect(locateInSession(single, '/wt/api/../other/x.md')).toBeNull();
    expect(locateInSession(single, '/wt/api')).toBeNull();
  });
});

describe('createShownFiles', () => {
  it('one a session; showing another replaces it; each change is announced; closing nothing announces nothing', () => {
    const changed: string[] = [];
    const now = new Date('2026-11-18T10:00:00Z');
    const shown = createShownFiles({ onChange: (id) => void changed.push(id), now: () => now });
    expect(shown.get('s1')).toBeNull();
    expect(shown.show('s1', { repo: 'api', path: 'a.md' })).toEqual({ repo: 'api', path: 'a.md', at: now.toISOString() });
    shown.show('s1', { repo: 'api', path: 'b.md' });
    expect(shown.get('s1')?.path).toBe('b.md');
    expect(shown.get('s2')).toBeNull();
    expect(shown.close('s1')).toBe(true);
    expect(shown.close('s1')).toBe(false);
    expect(shown.get('s1')).toBeNull();
    expect(changed).toEqual(['s1', 's1', 's1']);
  });
});

describe('insideFolders', () => {
  it('a file under one of the folders, never the folder itself nor a neighbour that starts the same', () => {
    expect(insideFolders('/tmp/claude-501/-a/x/scratchpad/page.html', ['/tmp/claude-501/-a'], 'darwin')).toBe(true);
    expect(insideFolders('/tmp/claude-501/-a', ['/tmp/claude-501/-a'], 'darwin')).toBe(false);
    expect(insideFolders('/tmp/claude-501/-ab/page.html', ['/tmp/claude-501/-a'], 'darwin')).toBe(false);
    expect(insideFolders('/tmp/claude-501/-b/page.html', ['/tmp/claude-501/-a'], 'darwin')).toBe(false);
    expect(insideFolders('/etc/passwd', [''], 'darwin')).toBe(false);
  });

  it('on Windows the case and the separators are not told apart', () => {
    expect(
      insideFolders(
        'C:\\Users\\Me\\AppData\\Local\\Temp\\claude\\C--x\\s\\a.html',
        ['c:/users/me/appdata/local/temp/claude/c--x'],
        'win32',
      ),
    ).toBe(true);
  });
});

describe('findTempFile (real files)', () => {
  let dir: string;
  let own: string;
  let other: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shown-temp-')));
    own = path.join(dir, 'own');
    other = path.join(dir, 'other');
    fs.mkdirSync(path.join(own, 'conv', 'scratchpad'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(own, 'conv', 'scratchpad', 'page.html'), '<h1>hi</h1>');
    fs.writeFileSync(path.join(other, 'secret.html'), 'not yours');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a file in the session's own scratch folders: its real path and size", async () => {
    const page = path.join(own, 'conv', 'scratchpad', 'page.html');
    expect(await findTempFile(page, [own])).toEqual({ real: page, size: 11 });
  });

  it('refuses another folder, a link out, a folder, a missing file, a relative or network path', async () => {
    expect(await findTempFile(path.join(other, 'secret.html'), [own])).toEqual({ error: 'outside' });
    const link = path.join(own, 'conv', 'scratchpad', 'link.html');
    fs.symlinkSync(path.join(other, 'secret.html'), link);
    expect(await findTempFile(link, [own])).toEqual({ error: 'outside' });
    expect(await findTempFile(path.join(own, 'conv'), [own])).toEqual({ error: 'not a file' });
    expect(await findTempFile(path.join(own, 'gone.html'), [own])).toEqual({ error: 'not there' });
    expect(await findTempFile('page.html', [own])).toEqual({ error: 'not a local absolute path' });
    expect(await findTempFile('//host/share/page.html', [own])).toEqual({ error: 'not a local absolute path' });
  });

  it('a folder is taken as given, never resolved: one that is a link widens nothing (sessionTempFolders names real ones)', async () => {
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(other, alias);
    expect(await findTempFile(path.join(other, 'secret.html'), [alias])).toEqual({ error: 'outside' });
    expect(await findTempFile(path.join(alias, 'secret.html'), [alias])).toEqual({ error: 'outside' });
  });

  it("refuses another machine's path before looking at it (a file:// host, a Windows stream)", async () => {
    const io = { realpath: vi.fn(), stat: vi.fn() };
    expect(await findTempFile('\\\\host\\share\\a.html', ['C:\\t'], io, 'win32')).toEqual({ error: 'not a local absolute path' });
    expect(await findTempFile('C:\\t\\a.txt:x.html', ['C:\\t'], io, 'win32')).toEqual({ error: 'not a local absolute path' });
    expect(io.realpath).not.toHaveBeenCalled();
  });
});

describe('readShownFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shown-read-')));
    fs.writeFileSync(path.join(dir, 'page.html'), '<h1>hi</h1>');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('the bytes of a plain file, up to the limit', async () => {
    expect(await readShownFile(path.join(dir, 'page.html'), 100)).toEqual({ bytes: Buffer.from('<h1>hi</h1>') });
    expect(await readShownFile(path.join(dir, 'page.html'), 11)).toEqual({ bytes: Buffer.from('<h1>hi</h1>') });
    expect(await readShownFile(path.join(dir, 'page.html'), 10)).toEqual({ error: 'too large' });
  });

  it.skipIf(process.platform === 'win32')('never through a link put in its place, nor a folder or a missing file', async () => {
    fs.writeFileSync(path.join(dir, 'secret'), 'not yours');
    fs.symlinkSync(path.join(dir, 'secret'), path.join(dir, 'swapped.html'));
    expect(await readShownFile(path.join(dir, 'swapped.html'), 100)).toEqual({ error: 'not there' });
    expect(await readShownFile(dir, 100)).toEqual({ error: 'not there' });
    expect(await readShownFile(path.join(dir, 'gone.html'), 100)).toEqual({ error: 'not there' });
  });
});
