import { describe, expect, it, vi } from 'vitest';
import { BranchFactsCache, createSessionBranches, factsKey } from '../../../src/core/stacks/branch-facts.js';
import type { CommandRunner } from '../../../src/core/pr/ship.js';
import type { SessionBranches } from '../../../src/core/sessions/session-branches.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import { sessionWire } from '../../../src/core/sessions/session-wire.js';

/** git answered from a table: `rev-parse --verify --quiet refs/heads/<b>` etc. */
function fakeGit(table: Record<string, { code: number; stdout: string }>): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (_cmd, args) => {
    calls.push(args);
    const hit = table[args.slice(2).join(' ')] ?? { code: 1, stdout: '' };
    return { ...hit, stderr: '' };
  };
  return Object.assign(run, { calls });
}

const T0 = Date.parse('2026-11-01T10:00:00Z');
const git = fakeGit({
  'rev-parse --abbrev-ref origin/HEAD': { code: 0, stdout: 'origin/dev\n' },
  'rev-parse --verify --quiet refs/heads/fix/a': { code: 0, stdout: 'aaaa\n' },
  'rev-list --count origin/dev..refs/heads/fix/a': { code: 0, stdout: '1\n' },
  'rev-parse --verify --quiet refs/heads/feat/x': { code: 0, stdout: 'xxxx\n' },
  'rev-parse --verify --quiet refs/remotes/origin/feat/x': { code: 0, stdout: 'xxxx\n' },
  'rev-list --count origin/dev..refs/heads/feat/x': { code: 0, stdout: '0\n' },
  'rev-list --count refs/remotes/origin/feat/x..refs/heads/feat/x': { code: 0, stdout: '0\n' },
});

describe('BranchFactsCache', () => {
  it('reads never wait: the first read is empty, the look runs in the background, a change is announced and kept', async () => {
    const onChange = vi.fn();
    const onFacts = vi.fn();
    const cache = new BranchFactsCache({ run: git, onChange, onFacts, now: () => T0 });
    const jobs = [
      { repo: 'api', path: '/wt', name: 'fix/a' },
      { repo: 'api', path: '/wt', name: 'feat/x' },
    ];
    expect(cache.get('s', jobs).size).toBe(0);
    await cache.idle();
    const facts = cache.get('s', jobs);
    expect(facts.get(factsKey('api', 'fix/a'))).toEqual({
      exists: true,
      sha: 'aaaa',
      pushed: false,
      commits: 1,
      unpushed: 1,
      merged: false,
    });
    expect(facts.get(factsKey('api', 'feat/x'))).toMatchObject({ pushed: true, commits: 0, merged: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onFacts).toHaveBeenCalledWith('s', expect.arrayContaining([expect.objectContaining({ name: 'fix/a', exists: true })]));
    // Fresh: no second look until the TTL passes or it's invalidated.
    const before = git.calls.length;
    cache.get('s', jobs);
    await cache.idle();
    expect(git.calls.length).toBe(before);
  });
});

describe('createSessionBranches (what work web wires into the sessions list)', () => {
  const s: WorktreeSession = {
    target: 'api',
    branch: 'feat/x',
    isGroup: false,
    paths: ['/wt/does-not-exist'],
    createdAt: '2026-10-01T00:00:00Z',
    lastAccessedAt: '2026-10-01T00:00:00Z',
  };
  const rec: SessionBranches = {
    backfilled: '2026-11-01T00:00:00Z',
    branches: [
      { repo: 'api', name: 'feat/x', firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-20T00:00:00Z' },
      { repo: 'api', name: 'fix/a', firstSeen: '2026-10-21T00:00:00Z', lastSeen: '2026-10-22T00:00:00Z' },
    ],
  };

  it('a session never backfilled is read from its reflog once, in the background; announced only when it moved branches', async () => {
    const backfill = vi.fn(() => rec);
    const onChange = vi.fn();
    const b = createSessionBranches({ run: git, now: () => T0, backfill, keepFacts: () => {}, onChange });
    expect(b.wire(s, null, null)).toBeNull();
    expect(b.wire(s, null, null)).toBeNull();
    await b.idle();
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalled();
    const quiet = vi.fn();
    const one = createSessionBranches({
      run: git,
      now: () => T0,
      backfill: () => ({ branches: [rec.branches[0]] }),
      keepFacts: () => {},
      onChange: quiet,
    });
    one.wire(s, null, null);
    await one.idle();
    expect(quiet).not.toHaveBeenCalled();
  });

  it("the row's branches: from the record at once, with the facts once looked at; into the session wire", async () => {
    const keepFacts = vi.fn();
    const b = createSessionBranches({ run: git, now: () => T0, backfill: () => rec, keepFacts });
    const first = b.wire(s, rec, null)!;
    expect(first.map((x) => [x.name, x.commits ?? null])).toEqual([
      ['fix/a', null],
      ['feat/x', null],
    ]);
    await b.idle();
    expect(keepFacts).toHaveBeenCalled();
    const w = sessionWire(s, { branchesFor: () => b.wire(s, rec, null) });
    expect(w.branches?.map((x) => [x.name, x.commits, x.pushed, x.merged])).toEqual([
      ['fix/a', 1, false, false],
      ['feat/x', 0, true, true],
    ]);
    // An archived session has none.
    expect(sessionWire({ ...s, archivedAt: '2026-11-01T00:00:00Z' }, { branchesFor: () => first }).branches).toBeUndefined();
  });
});
