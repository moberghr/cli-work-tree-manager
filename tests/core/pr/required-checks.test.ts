import { describe, expect, it } from 'vitest';
import { countedChecks, requiredChecksFor, withRequiredChecks } from '../../../src/core/pr/required-checks.js';
import { cleanRequiredChecks } from '../../../src/core/platform/config.js';
import type { RepoShipState, ShipPr } from '../../../src/core/api-types.js';

const pr = (over: Partial<ShipPr> = {}): ShipPr => ({
  number: 3657,
  url: 'https://github.com/kvika/straumur-backend/pull/3657',
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'BLOCKED',
  checks: 'fail',
  headSha: 'abc',
  failing: [{ name: 'OWASP Security Review', url: 'https://x/1' }],
  ...over,
});

describe('which failed checks count where the host requires none (prWatch.requiredChecks)', () => {
  it("a failed check not on the repo's list is set apart: grey, not failing", () => {
    const got = countedChecks(pr(), ['Test', 'Warning Check']);
    expect(got.checks).toBe('pass');
    expect(got.failing).toBeUndefined();
    expect(got.optionalFailing).toEqual([{ name: 'OWASP Security Review', url: 'https://x/1' }]);
  });

  it('only optional failures while another check still runs: running, never "passing"', () => {
    const got = countedChecks(pr({ checksRunning: true }), ['Test']);
    expect(got.checks).toBe('pending');
    expect(got.checksRunning).toBeUndefined();
    expect(got.optionalFailing).toEqual([{ name: 'OWASP Security Review', url: 'https://x/1' }]);
  });

  it('a listed check that fails still counts (names compared case-blind)', () => {
    const both = pr({ failing: [{ name: 'test' }, { name: 'OWASP Security Review' }] });
    expect(countedChecks(both, ['Test'])).toMatchObject({
      checks: 'fail',
      failing: [{ name: 'test' }],
      optionalFailing: [{ name: 'OWASP Security Review' }],
    });
  });

  it('no list, the host said which are required, or nothing failing: unchanged (the same object)', () => {
    const p = pr();
    expect(countedChecks(p, null)).toBe(p);
    const byHost = pr({ checksRequiredByHost: true });
    expect(countedChecks(byHost, ['Test'])).toBe(byHost);
    const passing = pr({ checks: 'pass', failing: undefined });
    expect(countedChecks(passing, ['Test'])).toBe(passing);
  });

  it("the list by alias, else by the host's owner/name, case-blind", () => {
    const lists = { 'straumur-backend': ['Test'], 'kvika/straumur-documentation': ['Build'] };
    expect(requiredChecksFor(lists, 'straumur-backend')).toEqual(['Test']);
    expect(requiredChecksFor(lists, 'docs', 'Kvika/Straumur-Documentation')).toEqual(['Build']);
    expect(requiredChecksFor(lists, 'web')).toBeNull();
    expect(requiredChecksFor(undefined, 'web')).toBeNull();
  });

  it("every PR of a preflight: the checked-out one, other branches', listed ones and those in other repos", () => {
    const repo = {
      name: 'straumur-backend',
      path: '/wt/b',
      branch: 'fix/probe',
      pr: pr({ number: 1 }),
      otherBranches: [{ name: 'fix/culture', exists: true, pushed: true, commits: 1, unpushed: 0, merged: false, pr: pr({ number: 2 }) }],
      listedPrs: [{ branch: 'fix/old', pr: pr({ number: 3 }) }],
    } as unknown as RepoShipState;
    const out = withRequiredChecks(
      { repos: [repo], elsewhere: [{ repo: 'kvika/straumur-documentation', pr: pr({ number: 4 }) }] },
      { 'straumur-backend': ['Test'], 'kvika/straumur-documentation': ['Test'] },
    );
    const all = [out.repos[0].pr, out.repos[0].otherBranches![0].pr, out.repos[0].listedPrs![0].pr, out.elsewhere![0].pr];
    expect(all.map((p) => p!.checks)).toEqual(['pass', 'pass', 'pass', 'pass']);
    const pre = { repos: [repo] };
    expect(withRequiredChecks(pre, undefined)).toBe(pre);
  });

  it('config: repo → names, strings only, blank ones dropped; nothing usable is no list', () => {
    expect(cleanRequiredChecks({ api: ['Test', ' ', 3, ' Build '], web: 'Test', '': ['x'], docs: [] })).toEqual({ api: ['Test', 'Build'] });
    expect(cleanRequiredChecks(['Test'])).toBeNull();
    expect(cleanRequiredChecks({ api: [] })).toBeNull();
  });
});
