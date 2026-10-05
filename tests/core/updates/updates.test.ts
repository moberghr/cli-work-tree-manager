import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  availableUpdate,
  compareVersions,
  DEV_UPDATE,
  inAppUpdates,
  installKindOf,
  NPM_UPDATE,
  parseDesktopUpdate,
  parseReleases,
  whatsNewFor,
  type ReleaseNote,
} from '../../../src/core/updates/updates.js';
import {
  createUpdates,
  fetchReleases,
  lookForUpdates,
  markSeenVersion,
  readDesktopUpdate,
  requestDesktop,
  seenVersion,
  type UpdatesDeps,
} from '../../../src/core/updates/update-source.js';

const note = (version: string, body = 'notes'): ReleaseNote => ({ version, name: `work ${version}`, body, publishedAt: '', url: '' });

describe('versions', () => {
  it('newer is newer, number by number; a pre-release sorts below its release; junk is never newer', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0);
    expect(compareVersions('2.1.0-beta.1', '2.1.0')).toBeLessThan(0);
    expect(compareVersions('dev', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', 'dev')).toBeGreaterThan(0);
  });
});

describe('parseReleases', () => {
  it('published versions only, newest first, named and dated as GitHub has them', () => {
    const notes = parseReleases([
      { tag_name: 'v2.0.0', name: '', body: 'two', published_at: '2026-09-20T00:00:00Z', html_url: 'u2' },
      { tag_name: 'v2.1.0', name: 'The review release', body: 'three' },
      { tag_name: 'v2.2.0', draft: true },
      { tag_name: 'v2.2.0-rc.1', prerelease: true },
      { tag_name: 'nightly' },
    ]);
    expect(notes.map((n) => [n.version, n.name])).toEqual([
      ['2.1.0', 'The review release'],
      ['2.0.0', 'work 2.0.0'],
    ]);
    expect(notes[1]).toMatchObject({ body: 'two', publishedAt: '2026-09-20T00:00:00Z', url: 'u2' });
    expect(parseReleases({ message: 'Not Found' })).toEqual([]);
  });
});

describe('availableUpdate', () => {
  const base = { running: '2.0.0', install: 'npm' as const, latest: '2.1.0', desktop: null };

  it('npm: the command; a git checkout: pull and build; current or a dev build: nothing', () => {
    expect(availableUpdate(base)).toEqual({ version: '2.1.0', how: 'command', command: NPM_UPDATE });
    expect(availableUpdate({ ...base, install: 'dev' })).toMatchObject({ command: DEV_UPDATE });
    expect(availableUpdate({ ...base, latest: '2.0.0' })).toBeNull();
    expect(availableUpdate({ ...base, running: 'dev' })).toBeNull();
    expect(availableUpdate({ ...base, latest: null })).toBeNull();
  });

  it('the desktop app: Restart once it has it; downloading while it gets it (its own word wins over the list)', () => {
    const app = (state: 'ready' | 'downloading' | 'current', target?: string) => ({ appVersion: '2.0.0', state, target });
    expect(availableUpdate({ ...base, install: 'desktop', desktop: app('ready', '2.1.0') })).toEqual({ version: '2.1.0', how: 'restart' });
    expect(availableUpdate({ ...base, install: 'desktop', desktop: app('downloading', '2.1.0') })).toEqual({
      version: '2.1.0',
      how: 'downloading',
    });
    // Newer on GitHub, the app hasn't started on it yet: it will.
    expect(availableUpdate({ ...base, install: 'desktop', desktop: app('current') })).toEqual({ version: '2.1.0', how: 'downloading' });
    // Ready for a version it already runs: nothing to restart into.
    expect(availableUpdate({ ...base, latest: '2.0.0', desktop: { appVersion: '2.1.0', state: 'ready', target: '2.1.0' } })).toBeNull();
  });
});

describe('availableUpdate while installing', () => {
  it('a Restart asked (installing) still offers Restart outside the app, never "downloading"', () => {
    const desktop = { appVersion: '2.0.2', state: 'installing' as const, target: '2.0.3' };
    expect(availableUpdate({ running: '2.0.2', install: 'desktop', latest: '2.0.3', desktop })).toEqual({
      version: '2.0.3',
      how: 'restart',
    });
  });
});

describe('inAppUpdates (the desktop app tells its window)', () => {
  // What a dev checkout's work web would say: its own version, a git command.
  const server = {
    running: '2.0.0',
    install: 'dev' as const,
    latest: '2.0.3',
    desktop: null,
    available: { version: '2.0.3', how: 'command' as const, command: DEV_UPDATE },
    whatsNew: null,
  };

  it("inside the app, the app's version and the app's update — never the server's", () => {
    const v = inAppUpdates(server, { appVersion: '2.0.2', state: 'current' });
    expect(v).toMatchObject({ running: '2.0.2', install: 'desktop', available: null, latest: '2.0.3' });
  });

  it('downloading carries how far; ready and installing offer Restart', () => {
    expect(inAppUpdates(server, { appVersion: '2.0.2', state: 'downloading', target: '2.0.3', progress: 45 }).available).toEqual({
      version: '2.0.3',
      how: 'downloading',
      progress: 45,
    });
    for (const state of ['ready', 'installing'] as const)
      expect(inAppUpdates(server, { appVersion: '2.0.2', state, target: '2.0.3' }).available).toEqual({ version: '2.0.3', how: 'restart' });
    // A target that isn't newer is no update.
    expect(inAppUpdates(server, { appVersion: '2.0.3', state: 'ready', target: '2.0.3' }).available).toBeNull();
  });

  it('the app file carries progress and installing; a progress out of range is dropped', () => {
    expect(parseDesktopUpdate('{"appVersion":"2.0.2","state":"downloading","target":"2.0.3","progress":44.6}')).toMatchObject({
      progress: 45,
    });
    expect(parseDesktopUpdate('{"appVersion":"2.0.2","state":"installing","target":"2.0.3"}')?.state).toBe('installing');
    expect(parseDesktopUpdate('{"appVersion":"2.0.2","state":"downloading","progress":400}')).not.toHaveProperty('progress');
  });
});

describe('whatsNewFor', () => {
  const notes = [note('2.1.0'), note('2.0.0')];
  it('once after an upgrade, when the version has notes; never on a first install', () => {
    expect(whatsNewFor({ running: '2.1.0', seen: '2.0.0', usedBefore: true, notes })).toBe('2.1.0');
    expect(whatsNewFor({ running: '2.1.0', seen: '2.1.0', usedBefore: true, notes })).toBeNull();
    // From a build before this feature: nothing seen, but sessions — an upgrade.
    expect(whatsNewFor({ running: '2.1.0', seen: null, usedBefore: true, notes })).toBe('2.1.0');
    expect(whatsNewFor({ running: '2.1.0', seen: null, usedBefore: false, notes })).toBeNull();
    expect(whatsNewFor({ running: '2.2.0', seen: '2.1.0', usedBefore: true, notes })).toBeNull(); // no notes for it
    expect(whatsNewFor({ running: 'dev', seen: null, usedBefore: true, notes })).toBeNull();
  });
});

describe('installKindOf', () => {
  it("the desktop app's copy, a git checkout, else npm", () => {
    expect(installKindOf('C:\\Users\\a\\.work\\runtime\\2.1.0', 'C:\\Users\\a\\.work', false)).toBe('desktop');
    expect(installKindOf('/home/a/src/work-tree', '/home/a/.work', true)).toBe('dev');
    expect(installKindOf('/usr/lib/node_modules/@moberg_hr/work-tree', '/home/a/.work', false)).toBe('npm');
  });
});

describe('the desktop app’s files', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('its status, while the app that wrote it runs; a left-over one says nothing', () => {
    const file = path.join(tmp, 'desktop-update.json');
    fs.writeFileSync(file, JSON.stringify({ appVersion: '2.0.0', state: 'ready', target: '2.1.0', pid: process.pid }));
    expect(readDesktopUpdate(file)).toMatchObject({ state: 'ready', target: '2.1.0' });
    fs.writeFileSync(file, JSON.stringify({ appVersion: '2.0.0', state: 'ready', target: '2.1.0', pid: 999_999_999 }));
    expect(readDesktopUpdate(file)).toBeNull();
    expect(parseDesktopUpdate('{"state":"exploded"}')).toBeNull();
    expect(readDesktopUpdate(path.join(tmp, 'none.json'))).toBeNull();
  });

  it('a request is one small file the app takes', () => {
    const file = path.join(tmp, 'desktop-request.json');
    requestDesktop('restart', file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ action: 'restart' });
  });
});

describe('fetchReleases', () => {
  const ok = (json: unknown) => async () => ({ ok: true, status: 200, json: async () => json });
  it('GitHub first; gh when GitHub refuses; both failing says why', async () => {
    const gh = vi.fn(async () => ({ code: 0, stdout: JSON.stringify([{ tag_name: 'v2.1.0' }]), stderr: '' }));
    expect((await fetchReleases(ok([{ tag_name: 'v2.0.0' }]), gh)).map((n) => n.version)).toEqual(['2.0.0']);
    expect(gh).not.toHaveBeenCalled();
    const limited = async () => ({ ok: false, status: 403, json: async () => ({}) });
    expect((await fetchReleases(limited, gh)).map((n) => n.version)).toEqual(['2.1.0']);
    const noGh = async () => ({ code: 127, stdout: '', stderr: '' });
    await expect(fetchReleases(limited, noGh)).rejects.toThrow(/limit for this address is spent; no gh/);
    await expect(fetchReleases(async () => Promise.reject(new Error('offline')), noGh)).rejects.toThrow(/offline/);
  });
});

describe('createUpdates', () => {
  const deps = (over: Partial<UpdatesDeps> = {}): UpdatesDeps => ({
    fetchReleases: async () => [note('2.1.0'), note('2.0.0')],
    running: '2.0.0',
    install: () => 'npm',
    desktop: () => null,
    seen: () => '2.0.0',
    usedBefore: () => true,
    now: () => Date.parse('2026-10-05T10:00:00Z'),
    ...over,
  });

  it('nothing known before the first look; after it, the newest release and what to do', async () => {
    const u = createUpdates(deps());
    expect(u.wire()).toMatchObject({ latest: null, available: null, checkedAt: null });
    await u.refresh();
    expect(u.wire()).toMatchObject({
      latest: '2.1.0',
      available: { how: 'command' },
      checkedAt: '2026-10-05T10:00:00.000Z',
      checkError: null,
    });
    expect(u.notes().map((n) => n.version)).toEqual(['2.1.0', '2.0.0']);
  });

  it('a failed look keeps what was known and says why; two at once ask once', async () => {
    let calls = 0;
    let fail = false;
    const u = createUpdates(
      deps({
        fetchReleases: async () => {
          calls++;
          if (fail) throw new Error('offline');
          return [note('2.1.0')];
        },
      }),
    );
    await Promise.all([u.refresh(), u.refresh()]);
    expect(calls).toBe(1);
    fail = true;
    await u.refresh();
    expect(u.wire()).toMatchObject({ latest: '2.1.0', checkError: 'offline' });
  });

  it('lookForUpdates notes the run and tells the dashboard only when the newest release moved', async () => {
    let releases = [note('2.0.0')];
    const u = createUpdates(deps({ fetchReleases: async () => releases }));
    const run = { done: vi.fn(), fail: vi.fn() };
    const changed = vi.fn();
    await lookForUpdates(u, run, changed);
    expect(run.done).toHaveBeenCalledWith('up to date (2.0.0)');
    expect(changed).toHaveBeenCalledTimes(1);
    await lookForUpdates(u, run, changed);
    expect(changed).toHaveBeenCalledTimes(1);
    releases = [note('2.1.0'), note('2.0.0')];
    await lookForUpdates(u, run, changed);
    expect(run.done).toHaveBeenLastCalledWith('work 2.1.0 is out (this is 2.0.0)');
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe('the version whose notes you saw', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('is kept in state.db', () => {
    expect(seenVersion()).toBeNull();
    markSeenVersion('2.1.0');
    expect(seenVersion()).toBe('2.1.0');
  });
});
