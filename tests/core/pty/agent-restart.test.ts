import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  busyForRestart,
  createRestarter,
  installedAt,
  installedAtCache,
  outdatedPtys,
  PRINTING_MS,
  RESTART_AT_ONCE,
  restartNotesSummary,
  restartPlan,
} from '../../../src/core/pty/agent-restart.js';
import { findOnPath } from '../../../src/core/platform/find-on-path.js';
import type { PtyInfo } from '../../../src/core/pty/pty-host-protocol.js';

const pty = (id: string, startedAt: string, extra: Partial<PtyInfo> = {}): PtyInfo => ({
  id,
  cwd: '/wt',
  pid: 1,
  exited: false,
  cols: 80,
  rows: 24,
  startedAt,
  restored: false,
  tool: 'claude',
  ...extra,
});

describe('which agents run a version from before their tool updated', () => {
  it('started before the file was installed: outdated; after it, an unknown tool or one not on PATH: not', () => {
    const at = Date.parse('2026-10-11T11:12:00Z');
    const ptys = [
      pty('old', '2026-10-08T09:00:00Z'),
      pty('new', '2026-10-12T09:00:00Z'),
      pty('host-from-before', '2026-10-08T09:00:00Z', { tool: undefined }),
      pty('elsewhere', '2026-10-08T09:00:00Z', { tool: 'opencode' }),
      pty('gone', '2026-10-08T09:00:00Z', { exited: true }),
    ];
    expect(outdatedPtys(ptys, (tool) => (tool === 'claude' ? at : null)).map((p) => p.id)).toEqual(['old']);
  });

  it('installedAt reads the file the command runs (through a link), null when it isn’t there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-'));
    try {
      const file = path.join(dir, 'claude.exe');
      fs.writeFileSync(file, 'x');
      const npm = new Date('1985-10-26T08:15:00Z');
      fs.utimesSync(file, npm, npm); // npm's fixed date on every unpacked file: the change time says when
      expect(installedAt('claude', () => file)!).toBeGreaterThan(Date.now() - 60_000);
      // Any other mtime is when it was written: a later chmod or relink (the change time) doesn't make it new.
      const written = new Date('2026-10-11T11:12:00Z');
      fs.utimesSync(file, written, written);
      expect(installedAt('claude', () => file)).toBe(written.getTime());
      expect(installedAt('claude', () => null)).toBeNull();
      expect(installedAt('claude', () => path.join(dir, 'missing'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('findOnPath: the first PATH match, with PATHEXT on Windows; a path is itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-path-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'on-path-'));
    try {
      fs.writeFileSync(path.join(dir, 'claude.exe'), 'x');
      fs.writeFileSync(path.join(other, 'claude'), 'x'); // npm's sh shim: cmd.exe never runs it
      fs.writeFileSync(path.join(other, 'claude.cmd'), 'x');
      // Windows: the PATHEXT forms only, so the first folder's claude.cmd, never its extension-less shim.
      expect(findOnPath('claude', { PATH: `${other};${dir}`, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path.join(other, 'claude.cmd'));
      expect(findOnPath('claude', { PATH: `${dir};${other}`, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path.join(dir, 'claude.exe'));
      expect(findOnPath('claude.exe', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBe(path.join(dir, 'claude.exe'));
      expect(findOnPath(path.join(dir, 'claude'), { PATHEXT: '.EXE' }, 'win32')).toBe(path.join(dir, 'claude.exe'));
      expect(findOnPath('nope', { PATH: dir }, 'linux')).toBeNull();
      if (process.platform !== 'win32') {
        // Elsewhere only an executable file counts: a stray one earlier in PATH is passed over.
        fs.writeFileSync(path.join(dir, 'claude'), 'x');
        fs.chmodSync(path.join(other, 'claude'), 0o755);
        expect(findOnPath('claude', { PATH: [dir, other].join(path.delimiter) }, 'linux')).toBe(path.join(other, 'claude'));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('restarting', () => {
  it('restartPlan: idle ones now, working or waiting ones after their turn', () => {
    expect(restartPlan(['a', 'b', 'a', 'c'], (id) => id === 'b')).toEqual({ now: ['a', 'c'], later: ['b'] });
  });

  const setup = (busy: Set<string>, running = new Set(['a', 'b', 'c']), printing = new Set<string>()) => {
    const restarted: string[] = [];
    const notes: string[] = [];
    const reports: number[] = [];
    const changed = vi.fn();
    const timers: Array<() => void> = [];
    const r = createRestarter({
      restart: async (id) => {
        if (id === 'c') throw new Error('host said no');
        restarted.push(id);
      },
      // Busy as work web reads it: its status, or (not right after its turn) a terminal still printing.
      busy: (id, opts) => busy.has(id) || (!opts?.turnEnded && printing.has(id)),
      running: (id) => running.has(id),
      report: (batch) => {
        reports.push(batch.length);
        for (const n of batch) notes.push(`${n.level} ${n.id}: ${n.text}`);
      },
      changed,
      later: (fn) => void timers.push(fn),
    });
    return { r, restarted, notes, reports, changed, timers };
  };

  it('restarts the idle ones now and the busy one when its turn ends — never mid-turn', async () => {
    const busy = new Set(['b']);
    const { r, restarted, changed } = setup(busy);
    const out = await r.request(['a', 'b', 'x']); // x isn't running: nothing to restart
    expect(out).toEqual({ now: ['a'], later: ['b'], failed: [] });
    expect(restarted).toEqual(['a']);
    expect(r.queued()).toEqual(['b']);
    expect(changed).toHaveBeenCalled();
    await r.turnEnded('b'); // a hook fired, but it is still working (a Stop that handed it more)
    expect(restarted).toEqual(['a']);
    busy.delete('b');
    await r.turnEnded('a'); // not queued: nothing
    await r.turnEnded('b');
    expect(restarted).toEqual(['a', 'b']);
    expect(r.queued()).toEqual([]);
  });

  it('retry: a queued one stopped meanwhile is dropped (it starts on the new version anyway); one now idle restarts', async () => {
    const busy = new Set(['a', 'b']);
    const running = new Set(['a', 'b']);
    const { r, restarted } = setup(busy, running);
    await r.request(['a', 'b']);
    running.delete('a');
    busy.delete('b');
    await r.retry();
    expect(restarted).toEqual(['b']);
    expect(r.queued()).toEqual([]);
  });

  it('right after its turn, its last message (printed a moment ago) does not keep it queued', async () => {
    const busy = new Set(['b']);
    const printing = new Set(['b']);
    const { r, restarted } = setup(busy, new Set(['b']), printing);
    await r.request(['b']);
    busy.delete('b'); // the Stop: idle now, its final message printed a second ago
    await r.turnEnded('b');
    expect(restarted).toEqual(['b']);
  });

  it('a turn-end the status has not caught up with yet: looked at again shortly, once', async () => {
    const busy = new Set(['b']);
    const { r, restarted, timers } = setup(busy, new Set(['b']));
    await r.request(['b']);
    await r.turnEnded('b'); // still reads as working
    expect(restarted).toEqual([]);
    expect(timers).toHaveLength(1);
    busy.delete('b');
    timers[0]();
    await new Promise((res) => setTimeout(res, 0));
    expect(restarted).toEqual(['b']);
  });

  it('one request is one report (one Activity run), its decisions in a line', async () => {
    const { r, reports, notes } = setup(new Set(['b']));
    await r.request(['a', 'b', 'c']);
    expect(reports).toEqual([3]);
    expect(notes).toEqual([
      'info b: restarts its agent when its turn ends (it is working or waiting on you)',
      'action a: restarted its agent (its conversation goes on)',
      "warn c: couldn't restart its agent: host said no",
    ]);
    expect(
      restartNotesSummary([
        { id: 'a', text: '', level: 'action' },
        { id: 'b', text: '', level: 'info' },
        { id: 'c', text: '', level: 'warn' },
      ]),
    ).toBe('1 restarted · 1 after its turn · 1 failed');
    expect(restartNotesSummary([])).toBe('nothing to restart');
  });

  it('asked again while one runs, it shares that one (and its failure)', async () => {
    let release!: () => void;
    let calls = 0;
    const r = createRestarter({
      restart: () => {
        calls++;
        return new Promise<void>((_res, rej) => (release = () => rej(new Error('did not stop'))));
      },
      busy: () => false,
      running: () => true,
    });
    const first = r.request(['a']);
    const second = r.request(['a']);
    await new Promise((res) => setTimeout(res, 0));
    release();
    expect(calls).toBe(1);
    expect((await second).failed).toEqual([{ id: 'a', error: 'did not stop' }]);
    expect((await first).failed).toEqual([{ id: 'a', error: 'did not stop' }]);
  });

  it('a restart that fails is reported, with why', async () => {
    const { r, notes } = setup(new Set());
    const out = await r.request(['c']);
    expect(out).toEqual({ now: [], later: [], failed: [{ id: 'c', error: 'host said no' }] });
    expect(notes).toContain("warn c: couldn't restart its agent: host said no");
  });
});

describe('busy, for a restart', () => {
  it('working or waiting on you; or, with no status (the assistant, a tool with no hooks), printing in the last few seconds', () => {
    const now = 1_000_000;
    expect(busyForRestart('working', null, now)).toBe(true);
    expect(busyForRestart('needs_input', null, now)).toBe(true);
    expect(busyForRestart('idle', null, now)).toBe(false);
    expect(busyForRestart(null, now - 2_000, now)).toBe(true);
    expect(busyForRestart(null, now - PRINTING_MS, now)).toBe(false);
    expect(busyForRestart('idle', now - 1_000, now)).toBe(true); // a turn the hooks missed is still printing
  });

  it('restarts a few at a time, not one after another', async () => {
    let running = 0;
    let most = 0;
    const r = createRestarter({
      restart: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((res) => setTimeout(res, 10));
        running--;
      },
      busy: () => false,
      running: () => true,
    });
    const out = await r.request(['a', 'b', 'c', 'd', 'e']);
    expect(out.now).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(most).toBe(RESTART_AT_ONCE);
  });
});

describe('installedAtCache', () => {
  it('looks a tool up again only after its time', () => {
    let t = 0;
    const look = vi.fn(() => 42);
    const at = installedAtCache(60_000, look, () => t);
    expect(at('claude')).toBe(42);
    t = 59_000;
    at('claude');
    expect(look).toHaveBeenCalledTimes(1);
    at('opencode');
    expect(look).toHaveBeenCalledTimes(2);
    t = 61_000;
    at('claude');
    expect(look).toHaveBeenCalledTimes(3);
  });
});
