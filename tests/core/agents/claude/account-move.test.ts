import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountMoveError, moveConversations } from '../../../../src/core/agents/claude/account-move.js';
import { encodeProjectDir } from '../../../../src/core/agents/claude/activity.js';
import { claudeAgent } from '../../../../src/core/agents/claude/adapter.js';
import { getConfigPath } from '../../../../src/core/platform/config.js';

/** Real folders: a session's conversations are `<account>/projects/<encoded cwd>/…`. */
let root: string;
let from: string;
let to: string;
const single = () => ({ isGroup: false, paths: [path.join(root, 'wt', 'api')] });
const group = () => ({ isGroup: true, paths: [path.join(root, 'wt', 'shop', 'backend'), path.join(root, 'wt', 'shop', 'web')] });
const proj = (account: string, cwd: string, ...rest: string[]) => path.join(account, 'projects', encodeProjectDir(cwd), ...rest);
const write = (file: string, text: string, ageMs = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
  }
};
const read = (file: string) => fs.readFileSync(file, 'utf-8');
const names = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-move-'));
  from = path.join(root, 'acc-default');
  to = path.join(root, 'acc-work');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('moveConversations', () => {
  it('moves the folder of a single repo session: transcripts, subagents and memory, as they were', () => {
    const s = single();
    write(proj(from, s.paths[0], 'a.jsonl'), 'A');
    write(proj(from, s.paths[0], 'a', 'subagents', 'agent-1.jsonl'), 'S');
    write(proj(from, s.paths[0], 'memory', 'MEMORY.md'), 'M');
    const r = moveConversations(s, from, to);
    expect(r.moved.length).toBeGreaterThan(0);
    expect(read(proj(to, s.paths[0], 'a.jsonl'))).toBe('A');
    expect(read(proj(to, s.paths[0], 'a', 'subagents', 'agent-1.jsonl'))).toBe('S');
    expect(read(proj(to, s.paths[0], 'memory', 'MEMORY.md'))).toBe('M');
    expect(fs.existsSync(proj(from, s.paths[0]))).toBe(false); // nothing left behind
  });

  it('a group: the folder of the group root and of each sub-repo it ran in; folders it never ran in are skipped', () => {
    const s = group();
    const groupRoot = path.dirname(s.paths[0]);
    write(proj(from, groupRoot, 'root.jsonl'), 'R');
    write(proj(from, s.paths[1], 'web.jsonl'), 'W');
    const r = moveConversations(s, from, to);
    expect(r.moved).toHaveLength(2);
    expect(read(proj(to, groupRoot, 'root.jsonl'))).toBe('R');
    expect(read(proj(to, s.paths[1], 'web.jsonl'))).toBe('W');
    expect(fs.existsSync(proj(to, s.paths[0]))).toBe(false);
  });

  it('works when there is nothing to move, or the two are the same folder', () => {
    expect(moveConversations(single(), from, to)).toEqual({ moved: [] });
    write(proj(from, single().paths[0], 'a.jsonl'), 'A');
    expect(moveConversations(single(), from, from)).toEqual({ moved: [] });
    expect(read(proj(from, single().paths[0], 'a.jsonl'))).toBe('A');
  });

  it('merges into a folder the target already has: files with no counterpart go across, directories merge', () => {
    const s = single();
    write(proj(from, s.paths[0], 'new.jsonl'), 'N');
    write(proj(from, s.paths[0], 'memory', 'a.md'), 'from-a');
    write(proj(to, s.paths[0], 'old.jsonl'), 'O');
    write(proj(to, s.paths[0], 'memory', 'b.md'), 'to-b');
    moveConversations(s, from, to);
    const dir = proj(to, s.paths[0]);
    expect(names(dir)).toEqual(['memory', 'new.jsonl', 'old.jsonl']);
    expect(names(path.join(dir, 'memory'))).toEqual(['a.md', 'b.md']);
    expect(read(path.join(dir, 'old.jsonl'))).toBe('O');
    expect(fs.existsSync(proj(from, s.paths[0]))).toBe(false);
  });

  it('a same-named file already there and newer is kept; the moved one is kept beside it with the account as a suffix', () => {
    const s = single();
    write(proj(from, s.paths[0], 'c.jsonl'), 'moved', 60_000);
    write(proj(to, s.paths[0], 'c.jsonl'), 'there');
    moveConversations(s, from, to, 'default');
    const dir = proj(to, s.paths[0]);
    expect(read(path.join(dir, 'c.jsonl'))).toBe('there');
    expect(read(path.join(dir, 'c.jsonl.from-default'))).toBe('moved');
  });

  it('a moved file that is the newer one takes the name, and the one that was there is kept beside it (nothing is overwritten)', () => {
    const s = single();
    write(proj(from, s.paths[0], 'c.jsonl'), 'moved');
    write(proj(to, s.paths[0], 'c.jsonl'), 'there', 60_000);
    moveConversations(s, from, to, 'default');
    const dir = proj(to, s.paths[0]);
    expect(read(path.join(dir, 'c.jsonl'))).toBe('moved');
    expect(read(path.join(dir, 'c.jsonl.from-default-older'))).toBe('there');
  });

  it('a suffixed name that is taken too gets a number', () => {
    const s = single();
    write(proj(from, s.paths[0], 'c.jsonl'), 'moved', 60_000);
    write(proj(to, s.paths[0], 'c.jsonl'), 'there');
    write(proj(to, s.paths[0], 'c.jsonl.from-default'), 'earlier');
    moveConversations(s, from, to, 'default');
    const dir = proj(to, s.paths[0]);
    expect(read(path.join(dir, 'c.jsonl.from-default'))).toBe('earlier');
    expect(read(path.join(dir, 'c.jsonl.from-default-2'))).toBe('moved');
  });

  it('across volumes (EXDEV) it copies and deletes instead', () => {
    const s = single();
    write(proj(from, s.paths[0], 'a.jsonl'), 'A');
    write(proj(from, s.paths[0], 'dir', 'b.jsonl'), 'B');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    moveConversations(s, from, to);
    expect(read(proj(to, s.paths[0], 'a.jsonl'))).toBe('A');
    expect(read(proj(to, s.paths[0], 'dir', 'b.jsonl'))).toBe('B');
    expect(fs.existsSync(proj(from, s.paths[0]))).toBe(false);
  });

  it('across volumes each file keeps its time, so the newest transcript (what --continue resumes) stays the newest (X1)', () => {
    const s = single();
    const day = 86_400_000;
    write(proj(from, s.paths[0], 'old.jsonl'), 'O', 3 * day);
    write(proj(from, s.paths[0], 'new.jsonl'), 'N', 1 * day);
    write(proj(from, s.paths[0], 'mid.jsonl'), 'M', 2 * day);
    write(proj(from, s.paths[0], 'new', 'subagents', 'agent-1.jsonl'), 'S', 5 * day);
    const before = (name: string) => fs.statSync(proj(from, s.paths[0], name)).mtimeMs;
    const times = {
      old: before('old.jsonl'),
      new: before('new.jsonl'),
      mid: before('mid.jsonl'),
      sub: before('new/subagents/agent-1.jsonl'),
    };
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    // Windows' file copy keeps a file's time by itself, POSIX's doesn't: the copy is asked to keep them everywhere.
    const cp = vi.spyOn(fs, 'cpSync');
    moveConversations(s, from, to);
    expect(cp.mock.calls.length).toBeGreaterThan(0);
    for (const c of cp.mock.calls) expect(c[2]).toMatchObject({ preserveTimestamps: true });
    const after = (name: string) => fs.statSync(proj(to, s.paths[0], name)).mtimeMs;
    // Copied, not renamed — and the times came along (to the millisecond the file system keeps).
    for (const [name, at] of [
      ['old.jsonl', times.old],
      ['new.jsonl', times.new],
      ['mid.jsonl', times.mid],
      ['new/subagents/agent-1.jsonl', times.sub],
    ] as const)
      expect(Math.abs(after(name) - at), name).toBeLessThan(2000);
    const newestFirst = ['old.jsonl', 'new.jsonl', 'mid.jsonl'].sort((a, b) => after(b) - after(a));
    expect(newestFirst).toEqual(['new.jsonl', 'mid.jsonl', 'old.jsonl']);
  });

  it('a copy whose original cannot be deleted leaves the entry whole where it was (no duplicate)', () => {
    const s = single();
    write(proj(from, s.paths[0], 'a.jsonl'), 'A');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    const realRm = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (String(p).startsWith(from)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return realRm(p, o);
    });
    expect(() => moveConversations(s, from, to)).toThrow(AccountMoveError);
    expect(read(proj(from, s.paths[0], 'a.jsonl'))).toBe('A');
    expect(fs.existsSync(proj(to, s.paths[0]))).toBe(false);
  });
});

/** Every file under each root, relative, with its content: what exists anywhere after a move. */
const filesUnder = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = fs.readFileSync(path.join(d, e.name), 'utf-8');
    }
  };
  walk(dir, '');
  return out;
};

describe('moveConversations: a delete that fails part way loses nothing', () => {
  const exdev = () =>
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
  /** rmSync of `target` removes its first child, then throws (a file in use), once; everything else is the real one. */
  const rmFailsAfterOneChild = (target: () => string) => {
    const realRm = fs.rmSync.bind(fs);
    let done = false;
    return vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => {
      if (!done && path.resolve(String(p)) === path.resolve(target())) {
        done = true;
        const first = fs.readdirSync(String(p)).sort()[0];
        realRm(path.join(String(p), first), { recursive: true, force: true });
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      }
      return realRm(p, o);
    });
  };

  it('the source half deleted: what went is put back from the copy, the copy taken back — every file once, where it was', () => {
    const s = single();
    write(proj(from, s.paths[0], 'a.jsonl'), 'A');
    write(proj(from, s.paths[0], 'b.jsonl'), 'B');
    write(proj(from, s.paths[0], 'memory', 'm.md'), 'M');
    exdev();
    rmFailsAfterOneChild(() => proj(from, s.paths[0]));
    expect(() => moveConversations(s, from, to)).toThrow(AccountMoveError);
    expect(filesUnder(proj(from, s.paths[0]))).toEqual({ 'a.jsonl': 'A', 'b.jsonl': 'B', 'memory/m.md': 'M' });
    expect(filesUnder(proj(to, s.paths[0]))).toEqual({});
  });

  it('what the delete took is put back with its own time (X1)', () => {
    const s = single();
    const day = 86_400_000;
    write(proj(from, s.paths[0], 'a.jsonl'), 'A', 4 * day);
    write(proj(from, s.paths[0], 'b.jsonl'), 'B', 2 * day);
    const at = (dir: string, n: string) => fs.statSync(proj(dir, s.paths[0], n)).mtimeMs;
    const was = { a: at(from, 'a.jsonl'), b: at(from, 'b.jsonl') };
    exdev();
    rmFailsAfterOneChild(() => proj(from, s.paths[0])); // takes a.jsonl, then fails
    const cp = vi.spyOn(fs, 'cpSync');
    expect(() => moveConversations(s, from, to)).toThrow(AccountMoveError);
    expect(cp.mock.calls).toHaveLength(2); // there, then back
    for (const c of cp.mock.calls) expect(c[2]).toMatchObject({ preserveTimestamps: true });
    expect(Math.abs(at(from, 'a.jsonl') - was.a)).toBeLessThan(2000);
    expect(Math.abs(at(from, 'b.jsonl') - was.b)).toBeLessThan(2000);
    expect(at(from, 'b.jsonl')).toBeGreaterThan(at(from, 'a.jsonl'));
  });

  it('the copy back failing too keeps the copy: each file in at least one place, never none', () => {
    const s = single();
    write(proj(from, s.paths[0], 'a.jsonl'), 'A');
    write(proj(from, s.paths[0], 'b.jsonl'), 'B');
    exdev();
    rmFailsAfterOneChild(() => proj(from, s.paths[0]));
    const realCp = fs.cpSync.bind(fs);
    vi.spyOn(fs, 'cpSync').mockImplementation((a, b, o) => {
      if (path.resolve(String(a)).startsWith(path.resolve(to))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realCp(a, b, o);
    });
    let err: unknown;
    try {
      moveConversations(s, from, to);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AccountMoveError);
    expect((err as Error).message).toMatch(/kept at/);
    const all = { ...filesUnder(proj(to, s.paths[0])), ...filesUnder(proj(from, s.paths[0])) };
    expect(all).toEqual({ 'a.jsonl': 'A', 'b.jsonl': 'B' });
  });

  it('the undo half deleting a moved entry keeps every file (stuck in the target, whole)', () => {
    const s = group();
    const groupRoot = path.dirname(s.paths[0]);
    write(proj(from, groupRoot, 'r1.jsonl'), 'R1');
    write(proj(from, groupRoot, 'r2.jsonl'), 'R2');
    write(proj(from, s.paths[0], 'be.jsonl'), 'B');
    exdev();
    // The second folder's copy fails, so the first folder's move is undone (copy back, delete in the target).
    const realCp = fs.cpSync.bind(fs);
    vi.spyOn(fs, 'cpSync').mockImplementation((a, b, o) => {
      if (path.resolve(String(a)) === path.resolve(proj(from, s.paths[0]))) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realCp(a, b, o);
    });
    rmFailsAfterOneChild(() => proj(to, groupRoot));
    let err: unknown;
    try {
      moveConversations(s, from, to);
    } catch (e) {
      err = e;
    }
    const e = err as AccountMoveError;
    expect(e).toBeInstanceOf(AccountMoveError);
    expect(e.stuck).toEqual([proj(to, groupRoot)]);
    const root1 = { ...filesUnder(proj(from, groupRoot)), ...filesUnder(proj(to, groupRoot)) };
    expect(root1).toEqual({ 'r1.jsonl': 'R1', 'r2.jsonl': 'R2' });
    expect(filesUnder(proj(to, groupRoot))).toEqual({ 'r1.jsonl': 'R1', 'r2.jsonl': 'R2' });
    expect(filesUnder(proj(from, s.paths[0]))).toEqual({ 'be.jsonl': 'B' });
  });
});

describe('moveConversations rollback', () => {
  it('a failure part way puts back what it moved (across the session folders), and says which entry failed', () => {
    const s = group();
    const groupRoot = path.dirname(s.paths[0]);
    write(proj(from, groupRoot, 'root.jsonl'), 'R');
    write(proj(from, s.paths[0], 'be.jsonl'), 'B');
    write(proj(from, s.paths[1], 'web.jsonl'), 'W');
    // The second folder's move fails.
    const real = fs.renameSync.bind(fs);
    let n = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (++n === 2) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return real(a, b);
    });
    let err: unknown;
    try {
      moveConversations(s, from, to);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AccountMoveError);
    const e = err as AccountMoveError;
    expect(e.message).toMatch(/EBUSY/);
    expect(e.message).toMatch(/back where it was/);
    expect(e.failed).toContain('projects');
    expect(e.stuck).toEqual([]);
    expect(e.restored).toHaveLength(1);
    // Everything is where it was; nothing in the target.
    expect(read(proj(from, groupRoot, 'root.jsonl'))).toBe('R');
    expect(read(proj(from, s.paths[0], 'be.jsonl'))).toBe('B');
    expect(read(proj(from, s.paths[1], 'web.jsonl'))).toBe('W');
    expect(fs.existsSync(proj(to, groupRoot))).toBe(false);
  });

  it('a failure while merging puts back each entry already moved, including a renamed older file', () => {
    const s = single();
    write(proj(from, s.paths[0], 'a.jsonl'), 'A');
    write(proj(from, s.paths[0], 'z.jsonl'), 'Znew');
    write(proj(to, s.paths[0], 'z.jsonl'), 'Zold', 60_000);
    // Entries go in directory order: a.jsonl (moved), then z.jsonl: the older one is renamed aside, then the move fails.
    const real = fs.renameSync.bind(fs);
    let n = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      if (++n === 3) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(a, b);
    });
    expect(() => moveConversations(s, from, to)).toThrow(AccountMoveError);
    expect(read(proj(from, s.paths[0], 'a.jsonl'))).toBe('A');
    expect(read(proj(from, s.paths[0], 'z.jsonl'))).toBe('Znew');
    expect(names(proj(to, s.paths[0]))).toEqual(['z.jsonl']);
    expect(read(proj(to, s.paths[0], 'z.jsonl'))).toBe('Zold');
  });

  it('says what could not be put back when the undo fails too', () => {
    const s = group();
    const groupRoot = path.dirname(s.paths[0]);
    write(proj(from, groupRoot, 'root.jsonl'), 'R');
    write(proj(from, s.paths[0], 'be.jsonl'), 'B');
    const real = fs.renameSync.bind(fs);
    let n = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
      n++;
      if (n >= 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); // the second move, and the undo of the first
      return real(a, b);
    });
    let err: unknown;
    try {
      moveConversations(s, from, to);
    } catch (e) {
      err = e;
    }
    const e = err as AccountMoveError;
    expect(e).toBeInstanceOf(AccountMoveError);
    expect(e.stuck).toHaveLength(1);
    expect(e.message).toContain('could not be');
    expect(e.message).toContain(e.stuck[0]);
  });
});

describe("Claude's accounts part of the adapter", () => {
  const accounts = claudeAgent.accounts!;
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ worktreesRoot: path.join(root, 'wt'), repos: {}, groups: {}, copyFiles: [], claudeAccounts: { work: to } }),
    );
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, '.credentials.json'), '{}');
  });

  it('lists the accounts with their folders and whether each is logged in', () => {
    expect(accounts.list().map((a) => [a.name, a.dir, a.isDefault, a.loggedIn])).toEqual([
      ['default', path.join(root, '.claude'), true, process.platform === 'darwin' ? null : false],
      ['work', to, false, true],
    ]);
    expect(accounts.current({})).toBe('default');
    expect(accounts.current({ account: 'work' })).toBe('work');
  });

  it("moves a session's conversations from its own account's folder to the other's", async () => {
    const s = { ...single(), target: 'api', branch: 'feat/x', createdAt: '', lastAccessedAt: '' };
    const defaultDir = path.join(root, '.claude');
    write(proj(defaultDir, s.paths[0], 'a.jsonl'), 'A');
    expect((await accounts.switchFiles(s, 'work')).moved.length).toBe(1);
    expect(read(proj(to, s.paths[0], 'a.jsonl'))).toBe('A');
    // And back: the session now records the other account.
    expect((await accounts.switchFiles({ ...s, account: 'work' }, 'default')).moved.length).toBe(1);
    expect(read(proj(defaultDir, s.paths[0], 'a.jsonl'))).toBe('A');
  });

  it('an account that is not in the config is refused, not guessed at', async () => {
    const s = { ...single(), target: 'api', branch: 'feat/x', createdAt: '', lastAccessedAt: '' };
    await expect(accounts.switchFiles(s, 'nope')).rejects.toThrow(/no account/);
    await expect(accounts.switchFiles({ ...s, account: 'gone' }, 'work')).rejects.toThrow(/not in your config/);
  });
});

describe("a repo's own checkout: only this session's conversation moves (review W2)", () => {
  it('onlyLatest: the newest transcript and its folder go; the others and memory stay', () => {
    const s = single();
    write(proj(from, s.paths[0], 'old-1.jsonl'), 'O1', 120_000);
    write(proj(from, s.paths[0], 'old-1', 'subagents', 'agent-a.jsonl'), 'OS', 120_000);
    write(proj(from, s.paths[0], 'mine.jsonl'), 'M');
    write(proj(from, s.paths[0], 'mine', 'subagents', 'agent-b.jsonl'), 'MS');
    write(proj(from, s.paths[0], 'memory', 'MEMORY.md'), 'shared');
    moveConversations(s, from, to, 'default', { onlyLatest: true });
    expect(filesUnder(proj(to, s.paths[0]))).toEqual({ 'mine.jsonl': 'M', 'mine/subagents/agent-b.jsonl': 'MS' });
    expect(filesUnder(proj(from, s.paths[0]))).toEqual({
      'old-1.jsonl': 'O1',
      'old-1/subagents/agent-a.jsonl': 'OS',
      'memory/MEMORY.md': 'shared',
    });
  });

  it("the adapter's switch on a repo's own folder moves only its conversation; on a worktree, the whole folder", async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    const own = single().paths[0];
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        worktreesRoot: path.join(root, 'trees'),
        repos: { api: own },
        groups: {},
        copyFiles: [],
        claudeAccounts: { work: to },
      }),
    );
    const defaultDir = path.join(root, '.claude');
    write(proj(defaultDir, own, 'other.jsonl'), 'X', 60_000);
    write(proj(defaultDir, own, 'mine.jsonl'), 'M');
    write(proj(defaultDir, own, 'memory', 'MEMORY.md'), 'shared');
    const s = { isGroup: false, paths: [own], target: 'api', branch: 'main', createdAt: '', lastAccessedAt: '' };
    await claudeAgent.accounts!.switchFiles(s, 'work');
    expect(filesUnder(proj(to, own))).toEqual({ 'mine.jsonl': 'M' });
    expect(filesUnder(proj(defaultDir, own))).toEqual({ 'other.jsonl': 'X', 'memory/MEMORY.md': 'shared' });
    // A worktree (not a repo's folder): everything.
    const wt = path.join(root, 'trees', 'api', 'feat-x');
    write(proj(defaultDir, wt, 'a.jsonl'), 'A');
    write(proj(defaultDir, wt, 'memory', 'MEMORY.md'), 'W');
    await claudeAgent.accounts!.switchFiles({ ...s, paths: [wt], branch: 'feat/x' }, 'work');
    expect(filesUnder(proj(to, wt))).toEqual({ 'a.jsonl': 'A', 'memory/MEMORY.md': 'W' });
  });

  it('folders: where a switch would move conversations (a group: its root and each repo)', () => {
    const g = group();
    expect(claudeAgent.accounts!.folders(g)).toEqual([path.dirname(g.paths[0]), ...g.paths]);
  });
});
