import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  busyForRestart,
  createRestarter,
  installedAt,
  outdatedPtys,
  PRINTING_MS,
  RESTART_AT_ONCE,
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
      const old = new Date('2020-01-01T00:00:00Z');
      fs.utimesSync(file, old, old); // npm's unpacked mtime: the change time still says when
      const at = installedAt('claude', () => file)!;
      expect(at).toBeGreaterThan(Date.now() - 60_000);
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

  const setup = (busy: Set<string>, running = new Set(['a', 'b', 'c'])) => {
    const restarted: string[] = [];
    const notes: string[] = [];
    const changed = vi.fn();
    const r = createRestarter({
      restart: async (id) => {
        if (id === 'c') throw new Error('host said no');
        restarted.push(id);
      },
      busy: (id) => busy.has(id),
      running: (id) => running.has(id),
      note: (id, text, level) => notes.push(`${level} ${id}: ${text}`),
      changed,
    });
    return { r, restarted, notes, changed };
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
