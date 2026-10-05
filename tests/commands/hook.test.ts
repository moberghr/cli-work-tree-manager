import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeHookOutput, runTurnHook } from '../../src/commands/hook.js';
import { isOwnCheckout, ownCheckoutNote } from '../../src/core/worktree/own-checkout.js';
import { readStatus } from '../../src/core/status/session-status.js';
import { clearCommentStoreCache, getCommentFileStore } from '../../src/core/comments/comment-file-store.js';
import { saveHistory, type WorktreeSession } from '../../src/core/sessions/history.js';
import { sessionIdFor } from '../../src/core/sessions/web-state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hook-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  clearCommentStoreCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCommentStoreCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeSession(): WorktreeSession {
  return {
    target: 'repo',
    isGroup: false,
    branch: 'feat/x',
    paths: ['C:/work/repo'],
    createdAt: '2026-01-01T00:00:00Z',
    lastAccessedAt: '2026-01-01T00:00:00Z',
  };
}

/** Force the session to look "active" so the activity-state guard doesn't
 *  short-circuit our test. We write a fresh transcript file at the path
 *  claude-activity computes from the session's cwd. */
function markActive(session: WorktreeSession): void {
  const cwd = session.paths[0];
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(tmpDir, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), '{}\n');
}

describe('computeHookOutput', () => {
  it('returns null when cwd is not a known session', () => {
    saveHistory([]);
    expect(computeHookOutput({ event: 'prompt-submit', cwd: 'C:/elsewhere' })).toBeNull();
  });

  it('returns null when nothing is pending', () => {
    const s = fakeSession();
    saveHistory([s]);
    markActive(s);
    expect(computeHookOutput({ event: 'prompt-submit', cwd: s.paths[0] })).toBeNull();
  });

  it('returns null when session activity is stale (no transcript)', () => {
    const s = fakeSession();
    saveHistory([s]);
    // Post a comment but DON'T mark the session active.
    getCommentFileStore(sessionIdFor(s)).post({ body: 'pending' });
    expect(computeHookOutput({ event: 'prompt-submit', cwd: s.paths[0] })).toBeNull();
  });

  it('prompt-submit returns plain text + ids', () => {
    const s = fakeSession();
    saveHistory([s]);
    markActive(s);
    const id = sessionIdFor(s);
    const c = getCommentFileStore(id).post({ body: 'fix this' });
    const out = computeHookOutput({ event: 'prompt-submit', cwd: s.paths[0] });
    expect(out).not.toBeNull();
    expect(out!.stdout).toContain('<system-reminder>');
    expect(out!.stdout).toContain('fix this');
    expect(out!.stdout.endsWith('\n')).toBe(true);
    expect(out!.deliveredIds).toEqual([c.id]);
    expect(out!.sessionId).toBe(id);
    // computeHookOutput is pure — it doesn't actually mark anything.
  });

  it('stop event returns the {decision:block, reason} JSON shape', () => {
    const s = fakeSession();
    saveHistory([s]);
    markActive(s);
    getCommentFileStore(sessionIdFor(s)).post({ body: 'address this' });
    const out = computeHookOutput({ event: 'stop', cwd: s.paths[0] });
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.stdout) as {
      decision: string;
      reason: string;
    };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('address this');
  });

  it('claude-authored comments are not surfaced (they came FROM claude)', () => {
    const s = fakeSession();
    saveHistory([s]);
    markActive(s);
    getCommentFileStore(sessionIdFor(s)).post({
      body: 'claude reply',
      author: 'claude',
    });
    expect(computeHookOutput({ event: 'prompt-submit', cwd: s.paths[0] })).toBeNull();
  });

  it('drafts are not surfaced until submitted', () => {
    const s = fakeSession();
    saveHistory([s]);
    markActive(s);
    getCommentFileStore(sessionIdFor(s)).post({
      body: 'still working on it',
      status: 'draft',
    });
    expect(computeHookOutput({ event: 'prompt-submit', cwd: s.paths[0] })).toBeNull();
  });
});

describe('runTurnHook (one hook per turn edge)', () => {
  it('turn-start: pending comments for Claude first, then the checkpoint seal and the status record', async () => {
    const s = fakeSession();
    saveHistory([s]);
    markActive(s);
    getCommentFileStore(sessionIdFor(s)).post({ body: 'fix this' });
    const out: string[] = [];
    const posts: string[] = [];
    await runTurnHook(
      true,
      { cwd: s.paths[0], prompt: 'go on' },
      { write: (t) => void out.push(t), post: async (r) => void posts.push(r) },
    );
    expect(out.join('')).toContain('fix this');
    expect(posts.sort()).toEqual(['api/checkpoint/seal', 'api/status-changed']);
    expect(readStatus(sessionIdFor(s))?.state).toBe('working');
  });

  it('turn-end: the stop delivery shape, a checkpoint and "done"; outside a session only the checkpoint nudge', async () => {
    const s = fakeSession();
    saveHistory([s]);
    markActive(s);
    getCommentFileStore(sessionIdFor(s)).post({ body: 'and the docs' });
    const out: string[] = [];
    const posts: string[] = [];
    await runTurnHook(false, { cwd: s.paths[0] }, { write: (t) => void out.push(t), post: async (r) => void posts.push(r) });
    expect(JSON.parse(out.join(''))).toMatchObject({ decision: 'block' });
    expect(posts.sort()).toEqual(['api/checkpoint', 'api/status-changed']);
    // It handed Claude the comment: the turn goes on (not a false "Done").
    expect(readStatus(sessionIdFor(s))).toMatchObject({ state: 'working', summary: 'Working on the comments you sent' });
    // Its real end: nothing more to hand over, so "done".
    await runTurnHook(false, { cwd: s.paths[0] }, { write: () => {}, post: async () => {} });
    expect(readStatus(sessionIdFor(s))).toMatchObject({ state: 'idle', seen: false });
    const elsewhere: string[] = [];
    await runTurnHook(false, { cwd: path.join(tmpDir, 'not-a-session') }, { write: () => {}, post: async (r) => void elsewhere.push(r) });
    expect(elsewhere).toEqual(['api/checkpoint']);
  });
});

describe("a repo's own checkout: its Claude stays on its branch", () => {
  it('turn-start tells it, every turn; a worktree is told nothing, and turn-end never', async () => {
    const own = { ...fakeSession(), branch: 'main' };
    saveHistory([own]);
    const write = (out: string[]) => (t: string) => void out.push(t);
    const out: string[] = [];
    await runTurnHook(
      true,
      { cwd: own.paths[0] },
      { write: write(out), post: async () => {}, ownCheckoutNote: () => ownCheckoutNote(own) },
    );
    expect(out.join('')).toContain("This folder is repo's own checkout, which work keeps on main");
    expect(out.join('')).toContain('`work tree repo <branch>`');
    const end: string[] = [];
    await runTurnHook(
      false,
      { cwd: own.paths[0] },
      { write: write(end), post: async () => {}, ownCheckoutNote: () => ownCheckoutNote(own) },
    );
    expect(end.join('')).not.toContain('own checkout');
    const wt: string[] = [];
    await runTurnHook(true, { cwd: own.paths[0] }, { write: write(wt), post: async () => {}, ownCheckoutNote: () => null });
    expect(wt.join('')).toBe('');
  });

  it("isOwnCheckout: the repo's folder however it is written, never a worktree of it", () => {
    const repos = { repo: String.raw`C:\work\repo\ `.trim() };
    expect(isOwnCheckout({ paths: ['c:/work/repo'] }, repos)).toBe(true);
    expect(isOwnCheckout({ paths: ['C:/work/worktrees/repo/feat-x'] }, repos)).toBe(false);
  });
});
