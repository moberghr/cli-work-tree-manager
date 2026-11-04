import { describe, it, expect } from 'vitest';
import { DemoScenario } from '../../../src/server/demo/scenario.js';
import { historyItems } from '../../../src/web/src/state/diff-history.js';
import { workElsewhere } from '../../../src/core/pr/branch-work.js';

/**
 * The demo's session that moved on after its PR merged (session-branches.ts): the same wire as work web — its
 * branches, the newest open PR as its stage with the merged one folded, the other branch's commit in the picker
 * and diffable, a turn marked as the branch switch, and Ship that doesn't call it done.
 */
describe('demo: a session that moved on to a second branch after its PR merged', () => {
  const scenario = new DemoScenario({ now: () => Date.parse('2026-09-29T09:00:00Z') });
  const id = 'demo-api-fix-webhook-retries';
  const wire = scenario.list().find((w) => w.id === id)!;

  it('its row: every branch, the checked-out one first, and the stage on the new open PR', () => {
    expect(wire.onOtherBranch).toEqual([{ repo: 'api', branch: 'fix/webhook-2xx' }]);
    expect(wire.branches?.map((b) => [b.name, b.current, b.pushed, b.pr?.number ?? null])).toEqual([
      ['fix/webhook-2xx', true, true, 221],
      ['fix/flaky-culture', false, false, null],
      ['fix/webhook-retries', false, true, 198],
    ]);
    expect(wire.prStage?.prs.map((p) => p.number)).toEqual([221]);
    expect(wire.prStage?.kind).toBe('in_review');
  });

  it("its PR watch check carries the branch and the other branches' PRs", () => {
    const ci = scenario.ci(id)!;
    expect(ci.repos[0]).toMatchObject({
      branch: 'fix/webhook-2xx',
      pr: { number: 221 },
      otherPrs: [{ branch: 'fix/webhook-retries', pr: { number: 198 } }],
    });
  });

  it("the picker: the other branch's commit, under its branch, and diffable; the last turn crossed the switch", () => {
    const commits = scenario.commits(id)!;
    const other = commits.find((c) => c.branch === 'fix/flaky-culture')!;
    expect(other.subject).toBe('Run every test under the invariant culture');
    const diff = scenario.pointDiff(id, { kind: 'parent', repo: 'api', sha: other.sha }, { kind: 'commit', repo: 'api', sha: other.sha });
    expect(diff?.repos[0].files.map((f) => f.path)).toEqual(['test/setup.ts']);
    const items = historyItems(scenario.checkpoints(id)!, commits, null);
    expect(items.find((i) => i.key === 't:2')?.switched).toBe('fix/webhook-retries → fix/webhook-2xx');
  });

  it("Ship: the other branches' state, and not done while one has a commit not pushed", () => {
    const pre = scenario.preflight(id)!;
    expect(pre.repos[0].branch).toBe('fix/webhook-2xx');
    expect(workElsewhere(pre)).toEqual(['api: fix/flaky-culture — 1 commit not pushed']);
  });
});
