import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/core/git/git.js';
import { headBroughtInOtherWork, takeCheckpoint } from '../../../src/core/diff/checkpoint.js';

/**
 * A session's turns survive its own commits, but not a HEAD move that brought
 * in someone else's work — the next turn would show it as Claude's. Real git:
 * an upstream with a main branch, and a clone working on feat/x.
 */
let home: string;
let upstream: string;
let wt: string;
const repos = () => [{ name: wt, root: wt }];
const HASH = 'headmoves';

function commitIn(dir: string, file: string, msg: string) {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', msg, '--no-gpg-sign'], dir);
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'head-moves-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  upstream = path.join(home, 'upstream');
  fs.mkdirSync(upstream);
  git(['init', '-q', '-b', 'main'], upstream);
  git(['config', 'user.email', 't@t.t'], upstream);
  git(['config', 'user.name', 'Test'], upstream);
  commitIn(upstream, 'base.txt', 'base');
  wt = path.join(home, 'wt');
  git(['clone', '-q', upstream, wt], home);
  git(['config', 'user.email', 't@t.t'], wt);
  git(['config', 'user.name', 'Test'], wt);
  git(['checkout', '-q', '-b', 'feat/x'], wt);
  // A turn: a change, checkpointed.
  fs.writeFileSync(path.join(wt, 'mine.txt'), 'turn one\n');
  expect(await takeCheckpoint(HASH, repos())).not.toBeNull();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Main moves on upstream, and the clone fetches it. */
function mainMovesOn() {
  commitIn(upstream, 'theirs.txt', 'theirs');
  git(['fetch', '-q', 'origin'], wt);
}

describe('headBroughtInOtherWork', () => {
  it('nothing moved, or only its own commits on top: the turns stay', () => {
    expect(headBroughtInOtherWork(HASH, repos())).toBe(false);
    git(['add', '.'], wt);
    git(['commit', '-q', '-m', 'mine', '--no-gpg-sign'], wt);
    commitIn(wt, 'more.txt', 'more of mine');
    expect(headBroughtInOtherWork(HASH, repos())).toBe(false);
  });

  it("main merged in (Update from main on a pushed branch): another's work came in", () => {
    mainMovesOn();
    git(['add', '.'], wt);
    git(['commit', '-q', '-m', 'mine', '--no-gpg-sign'], wt);
    git(['merge', '-q', '--no-edit', 'origin/main'], wt);
    expect(headBroughtInOtherWork(HASH, repos())).toBe(true);
  });

  it('rebased onto main: what was underneath is gone', () => {
    git(['add', '.'], wt);
    git(['commit', '-q', '-m', 'mine', '--no-gpg-sign'], wt);
    expect(headBroughtInOtherWork(HASH, repos())).toBe(false);
    mainMovesOn();
    git(['stash', '-q', '--include-untracked'], wt); // nothing, but keep rebase happy
    git(['rebase', '-q', 'origin/main'], wt);
    expect(headBroughtInOtherWork(HASH, repos())).toBe(true);
  });

  it("fast-forwarded to main's new commits (a pull): another's work came in", () => {
    mainMovesOn();
    git(['merge', '-q', '--ff-only', 'origin/main'], wt);
    expect(headBroughtInOtherWork(HASH, repos())).toBe(true);
  });
});
