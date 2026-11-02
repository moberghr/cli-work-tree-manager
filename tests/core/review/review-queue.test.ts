import { describe, expect, it, vi } from 'vitest';
import { candidates, createReviewQueue, type ReviewProject, type ReviewStore } from '../../../src/core/review/review-queue.js';
import { reviewKey } from '../../../src/core/review/review-store.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import type { GitHost, OpenPr } from '../../../src/core/hosts/types.js';
import type { PrReviewWire } from '../../../src/core/api-types.js';
import { github } from '../../../src/core/hosts/github/adapter.js';

const pr = (number: number, over: Partial<OpenPr> = {}): OpenPr => ({
  number,
  title: `PR ${number}`,
  url: `https://example/pr/${number}`,
  branch: `feat/${number}`,
  headSha: `sha${number}`,
  base: 'main',
  author: 'ana',
  isDraft: false,
  additions: 10,
  deletions: 2,
  requested: [],
  ...over,
});

describe('candidates: which open PRs a project reviews', () => {
  it('all: every open PR but drafts and your own; asked: only those asking you by name; off: none — each left out with why', () => {
    const prs = [pr(1), pr(2, { isDraft: true }), pr(3, { author: 'Me' }), pr(4, { requested: ['me'] })];
    expect(candidates(prs, 'all', 'me').take.map((p) => p.number)).toEqual([1, 4]);
    expect(candidates(prs, 'asked', 'me').take.map((p) => p.number)).toEqual([4]);
    const off = candidates(prs, 'off', 'me');
    expect(off.take).toEqual([]);
    expect(candidates(prs, 'all', 'me').left.map((l) => [l.pr.number, l.why])).toEqual([
      [2, 'a draft'],
      [3, 'your own'],
    ]);
    expect(off.left[0].why).toBe('reviews are off for this project');
  });
});

const DIFF = `diff --git a/src/Refunds.cs b/src/Refunds.cs
index 1..2 100644
--- a/src/Refunds.cs
+++ b/src/Refunds.cs
@@ -1,2 +1,3 @@
 class Refunds {
+  decimal Refund(decimal x) => x;
 }
diff --git a/package-lock.json b/package-lock.json
index 1..2 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{"a":1}
+{"a":2}
`;

function harness(
  opts: {
    prs?: OpenPr[];
    agent?: (p: string) => Promise<string | null>;
    maxPerDay?: number;
    maxLines?: number;
    mode?: ReviewProject['mode'];
  } = {},
) {
  const rows = new Map<string, PrReviewWire>();
  const store: ReviewStore = {
    read: (r, n) => rows.get(reviewKey(r, n)) ?? null,
    write: (r) => void rows.set(reviewKey(r.repo, r.number), r),
    all: () => [...rows.values()],
    keepOnly: (repos, open) => {
      let gone = 0;
      for (const k of [...rows.keys()]) if (repos.includes(k.split('#')[0]) && !open.has(k)) gone += rows.delete(k) ? 1 : 0;
      return gone;
    },
  };
  let open = opts.prs ?? [pr(7)];
  const host: GitHost = { ...github, openPrs: async () => ({ ok: true, prs: open }), viewer: async () => 'me' };
  const prepare = vi.fn(async (_path: string, _host: GitHost, p: { number: number }) => ({
    ok: true as const,
    files: parseGitDiff(DIFF),
    extras: { whitespaceOnly: new Set<string>(), generated: new Set<string>() },
    mergeBase: 'mb',
    headSha: `sha${p.number}`,
  }));
  const changed = vi.fn();
  const queue = createReviewQueue({
    projects: () => [{ alias: 'api', path: '/repos/api', mode: opts.mode ?? 'all' }],
    hostOf: () => host,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    prepare,
    ...(opts.agent ? { agent: opts.agent } : {}),
    store,
    limits: () => ({ maxPerDay: opts.maxPerDay ?? 10, maxLines: opts.maxLines ?? 3000 }),
    changed,
    now: () => new Date('2026-11-02T10:00:00'),
  });
  return { queue, rows, prepare, changed, setOpen: (p: OpenPr[]) => void (open = p) };
}

describe('the review queue', () => {
  it('prepares a new PR: kinds, stories (by folder without an agent, saying so), once per head', async () => {
    const h = harness();
    await h.queue.sweep();
    const r = h.rows.get('api#7')!;
    expect(r.status).toBe('ready');
    expect(r.files.map((f) => [f.path, f.kind])).toEqual([
      ['src/Refunds.cs', 'logic'],
      ['package-lock.json', 'generated'],
    ]);
    expect(r.stories.map((s) => [s.title, s.by])).toEqual([['src', 'folder']]);
    expect(r.why).toBe('no agent for the AI step: stories are by folder');
    expect(r.mergeBase).toBe('mb');
    await h.queue.sweep(); // the same head: not again
    expect(h.prepare).toHaveBeenCalledTimes(1);
    h.setOpen([pr(7, { headSha: 'sha7b' })]); // a push: again
    await h.queue.sweep();
    expect(h.prepare).toHaveBeenCalledTimes(2);
  });

  it('the AI step: its stories and drafts; an unusable answer falls back to folders and says so', async () => {
    const answer = JSON.stringify({
      stories: [{ title: 'Adds refunds', why: 'w', risk: 'money', riskLevel: 4, flags: ['security'], files: ['src/Refunds.cs'] }],
      notes: [{ path: 'src/Refunds.cs', line: 2, body: 'Negative amounts?' }],
    });
    const agent = vi.fn(async (_prompt: string) => answer);
    const h = harness({ agent });
    await h.queue.sweep();
    const r = h.rows.get('api#7')!;
    expect(agent.mock.calls[0][0]).toContain('src/Refunds.cs'); // only the Logic file is shown
    expect(agent.mock.calls[0][0]).not.toContain('package-lock.json');
    expect(r.aiStep).toBe('done');
    expect(r.stories[0]).toMatchObject({ title: 'Adds refunds', flags: ['security', 'no-tests'], by: 'ai' });
    expect(r.drafts).toEqual([{ id: 'd1', path: 'src/Refunds.cs', line: 2, body: 'Negative amounts?', state: 'draft' }]);

    const bad = harness({ agent: async () => 'no idea' });
    await bad.queue.sweep();
    expect(bad.rows.get('api#7')).toMatchObject({ aiStep: 'failed', why: 'the AI step gave no usable answer: stories are by folder' });
  });

  it('a PR over the size limit, or past the day’s cap, waits — with why; a click prepares it anyway', async () => {
    const big = harness({ prs: [pr(8, { additions: 4000 })], maxLines: 3000 });
    await big.queue.sweep();
    expect(big.rows.get('api#8')).toMatchObject({ status: 'waiting', why: expect.stringContaining('over the size limit (3000)') });
    expect(big.prepare).not.toHaveBeenCalled();
    expect(await big.queue.runNow('api', 8)).toMatchObject({ ok: true, review: { status: 'ready' } });

    const capped = harness({ prs: [pr(1), pr(2)], maxPerDay: 1 });
    await capped.queue.sweep();
    expect([capped.rows.get('api#1')!.status, capped.rows.get('api#2')!.status]).toEqual(['ready', 'waiting']);
    expect(capped.rows.get('api#2')!.why).toContain("today's 1 automatic reviews are done");
  });

  it('a project set to off is never swept, and reviews of PRs no longer open go', async () => {
    const off = harness({ mode: 'off' });
    await off.queue.sweep();
    expect(off.rows.size).toBe(0);

    const h = harness({ prs: [pr(1), pr(2)] });
    await h.queue.sweep();
    h.setOpen([pr(2)]);
    await h.queue.sweep();
    expect([...h.rows.keys()]).toEqual(['api#2']);
  });

  it('a prepare that fails is recorded as failed with the reason; runNow refuses a PR that isn’t open', async () => {
    const h = harness();
    h.prepare.mockResolvedValueOnce({ ok: false, error: "couldn't fetch the PR's code: denied" } as never);
    await h.queue.sweep();
    expect(h.rows.get('api#7')).toMatchObject({ status: 'failed', why: "couldn't fetch the PR's code: denied" });
    expect(await h.queue.runNow('api', 99)).toEqual({ ok: false, error: "#99 isn't an open pull request of api" });
    expect(await h.queue.runNow('web', 1)).toEqual({ ok: false, error: "web isn't one of your repos" });
  });
});
