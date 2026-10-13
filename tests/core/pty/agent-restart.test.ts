import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  busyForRestart,
  createRestarter,
  installedAt,
  installedAtCache,
  installTime,
  QUEUE_RECHECK_MS,
  TURN_END_GRACE_MS,
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
      fs.utimesSync(file, npm, npm); // npm's fixed date on every unpacked file: its creation (or change) says when
      expect(installedAt('claude', () => file)!).toBeGreaterThan(Date.now() - 60_000);
      expect(installedAt('claude', () => null)).toBeNull();
      expect(installedAt('claude', () => path.join(dir, 'missing'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installTime: the later of written and created; npm's fixed date counts as neither; a chmod (the change time) never", () => {
    const t = (iso: string) => Date.parse(iso);
    const npm = t('1985-10-26T08:15:00Z');
    // A new file of the build's date, copied in today: created today.
    expect(
      installTime({ mtimeMs: t('2026-10-10T00:00:00Z'), birthtimeMs: t('2026-10-12T09:00:00Z'), ctimeMs: t('2026-10-12T09:00:00Z') }),
    ).toBe(t('2026-10-12T09:00:00Z'));
    // Written after it was created (an in-place update).
    expect(
      installTime({ mtimeMs: t('2026-10-12T09:00:00Z'), birthtimeMs: t('2026-09-01T00:00:00Z'), ctimeMs: t('2026-10-12T09:00:00Z') }),
    ).toBe(t('2026-10-12T09:00:00Z'));
    // A chmod today moves only the change time: not an update.
    expect(
      installTime({ mtimeMs: t('2026-10-10T00:00:00Z'), birthtimeMs: t('2026-10-10T00:00:00Z'), ctimeMs: t('2026-10-13T08:00:00Z') }),
    ).toBe(t('2026-10-10T00:00:00Z'));
    // npm's date where creation isn't recorded (0): the unpacking's change time.
    expect(installTime({ mtimeMs: npm, birthtimeMs: 0, ctimeMs: t('2026-10-12T09:00:00Z') })).toBe(t('2026-10-12T09:00:00Z'));
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
    const timers: Array<(() => void) & { ms?: number }> = [];
    /** Run the timers set so far (a turn end's grace, the queue's recheck), then let their restarts land. */
    const fire = async (ms?: number) => {
      for (const f of timers.splice(0).filter((f) => ms === undefined || f.ms === ms)) f();
      await new Promise((res) => setTimeout(res, 0));
    };
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
      later: (fn, ms) => void timers.push(Object.assign(fn, { ms })),
    });
    return { r, restarted, notes, reports, changed, timers, fire };
  };

  it('restarts the idle ones now and the busy one when its turn ends — never mid-turn', async () => {
    const busy = new Set(['b']);
    const { r, restarted, changed, fire } = setup(busy);
    const out = await r.request(['a', 'b']); // what the route found running
    expect(out).toEqual({ now: ['a'], later: ['b'], failed: [] });
    expect(restarted).toEqual(['a']);
    expect(r.queued()).toEqual(['b']);
    expect(changed).toHaveBeenCalled();
    r.turnEnded('b'); // a hook fired, but it is still working (a Stop that handed it more)
    await fire(TURN_END_GRACE_MS);
    expect(restarted).toEqual(['a']);
    busy.delete('b');
    r.turnEnded('a'); // not queued: nothing
    r.turnEnded('b');
    expect(restarted).toEqual(['a']); // not at once: its turn-end hooks still run as its children
    await fire(TURN_END_GRACE_MS);
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
    const { r, restarted, fire } = setup(busy, new Set(['b']), printing);
    await r.request(['b']);
    busy.delete('b'); // the Stop: idle now, its final message printed a second ago
    r.turnEnded('b');
    await fire(TURN_END_GRACE_MS);
    expect(restarted).toEqual(['b']);
  });

  it('while anything waits it is looked at again every so often: a turn no hook reported, or a terminal only redrawing', async () => {
    const busy = new Set<string>();
    const printing = new Set(['b']); // idle, but it redrew a moment ago (opened, resized)
    const { r, restarted, timers, fire } = setup(busy, new Set(['b']), printing);
    expect((await r.request(['b'])).later).toEqual(['b']);
    expect(timers.map((t) => t.ms)).toEqual([QUEUE_RECHECK_MS]); // one recheck, not one per request
    await r.request(['b']);
    expect(timers).toHaveLength(1);
    await fire(QUEUE_RECHECK_MS); // still redrawing: checked again later
    expect(restarted).toEqual([]);
    printing.delete('b');
    await fire(QUEUE_RECHECK_MS);
    expect(restarted).toEqual(['b']);
    expect(timers).toEqual([]); // nothing waits: no more rechecks
  });

  it('one request is one report (one Activity run), its decisions in a line', async () => {
    const { r, reports, notes } = setup(new Set(['b']));
    await r.request(['a', 'b', 'c']);
    expect(reports).toEqual([3]);
    expect(notes).toEqual([
      'info b: restarts when its turn ends (it is working or waiting on you)',
      'action a: restarted its agent (its conversation goes on)',
      "warn c: couldn't restart its agent: host said no",
    ]);
    expect(
      restartNotesSummary([
        { id: 'a', text: '', level: 'action' },
        { id: 'b', text: '', level: 'info' },
        { id: 'c', text: '', level: 'warn' },
      ]),
    ).toBe("1 session restarted · 1 restarts when its turn ends · 1 couldn't.");
    expect(restartNotesSummary([])).toBe('Nothing to restart.');
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

  it('on a PTY host from before restart-in-place, it says how it went instead', async () => {
    const notes: string[] = [];
    const r = createRestarter({
      restart: async () => 'stopped and started again (an older PTY host)',
      busy: () => false,
      running: () => true,
      report: (batch) => notes.push(...batch.map((n) => n.text)),
    });
    expect((await r.request(['a'])).now).toEqual(['a']);
    expect(notes).toEqual(['stopped and started again (an older PTY host)']);
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
    // Claude Code's own word: the assistant (no status) silent at a permission dialog is not idle.
    expect(busyForRestart(null, now - 60_000, now, 'waiting')).toBe(true);
    expect(busyForRestart(null, now - 60_000, now, 'busy')).toBe(true);
    expect(busyForRestart(null, now - 60_000, now, 'idle')).toBe(false);
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

  it('restarts what the caller found running (its list is fresh; the pool cache may not have it yet)', async () => {
    const restarted: string[] = [];
    const r = createRestarter({ restart: async (id) => void restarted.push(id), busy: () => false, running: () => false });
    expect((await r.request(['just-started'])).now).toEqual(['just-started']);
    expect(restarted).toEqual(['just-started']);
  });

  it('says when it looks at the waiting ones next (the Activity schedule), and notes one dropped because it was stopped', async () => {
    const scheduled: Array<number | null> = [];
    const notes: string[] = [];
    const timers: Array<() => void> = [];
    const running = new Set(['a']);
    const r = createRestarter({
      restart: async () => {},
      busy: () => true,
      running: (id) => running.has(id),
      report: (batch) => notes.push(...batch.map((n) => `${n.id}: ${n.text}`)),
      scheduled: (at) => scheduled.push(at),
      later: (fn) => void timers.push(fn),
    });
    await r.request(['a']);
    expect(typeof scheduled.at(-1)).toBe('number');
    running.delete('a');
    timers.shift()!();
    await new Promise((res) => setTimeout(res, 0));
    expect(notes.at(-1)).toBe('a: no longer waits to restart: it was stopped meanwhile (it starts on the new version)');
    expect(scheduled.at(-1)).toBeNull();
    expect(r.queued()).toEqual([]);
  });

  it('lists what it is restarting right now', async () => {
    let release!: () => void;
    const r = createRestarter({
      restart: () => new Promise<void>((res) => (release = res)),
      busy: () => false,
      running: () => true,
    });
    const going = r.request(['a']);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.restarting()).toEqual(['a']);
    release();
    await going;
    expect(r.restarting()).toEqual([]);
  });
});
