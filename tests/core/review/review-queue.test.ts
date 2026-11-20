import { describe, expect, it, vi } from 'vitest';
import {
  candidates,
  createReviewQueue,
  upToDate,
  withStatus,
  type ReviewProject,
  type ReviewQueueDeps,
  type ReviewStore,
} from '../../../src/core/review/review-queue.js';
import { CHECKOUT_LINES } from '../../../src/core/review/review-plan.js';
import { reviewKey } from '../../../src/core/review/review-store.js';
import { parseGitDiff } from '../../../src/core/diff/diff-parse.js';
import { createActivityLog } from '../../../src/core/platform/activity.js';
import type { GitHost, OpenPr } from '../../../src/core/hosts/types.js';
import type { PrReviewWire } from '../../../src/core/api-types.js';
import type { PreparedPr } from '../../../src/core/review/review-source.js';
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

const prepared = (headSha: string): { ok: true } & PreparedPr => ({
  ok: true as const,
  files: parseGitDiff(DIFF),
  extras: { whitespaceOnly: new Set<string>(), generated: new Set<string>() },
  mergeBase: 'mb',
  headSha,
});

/** The agent's own words on its read-only run (`oneShot.readOnly.promptLines`), as a made-up agent says them. */
const AGENT_LINES = ['You are an agent reading a checkout with its own file tools.'];

function harness(
  opts: {
    prs?: OpenPr[];
    agent?: (p: string) => Promise<string | null>;
    agentInCheckout?: ReviewQueueDeps['agentInCheckout'];
    checkoutLines?: ReviewQueueDeps['checkoutLines'];
    sweepTrees?: ReviewQueueDeps['sweepTrees'];
    maxPerDay?: number | null;
    maxLines?: number;
    mode?: ReviewProject['mode'];
    viewer?: string | null;
    host?: Partial<GitHost>;
  } = {},
) {
  const rows = new Map<string, PrReviewWire>();
  const store: ReviewStore = {
    read: (r, n) => rows.get(reviewKey(r, n)) ?? null,
    update: (r, n, change) => {
      const was = rows.get(reviewKey(r, n));
      if (!was) return null;
      const next = change(was);
      rows.set(reviewKey(r, n), next);
      return next;
    },
    upsert: (r, n, change) => {
      const next = change(rows.get(reviewKey(r, n)) ?? null);
      rows.set(reviewKey(r, n), next);
      return next;
    },
    all: () => [...rows.values()],
    keepOnly: (repos, open) => {
      const gone: Array<{ repo: string; number: number }> = [];
      for (const [k, v] of [...rows])
        if (repos.includes(v.repo) && !open.has(k)) {
          rows.delete(k);
          gone.push({ repo: v.repo, number: v.number });
        }
      return gone;
    },
  };
  let open = opts.prs ?? [pr(7)];
  let more = false;
  const host: GitHost = {
    ...github,
    openPrs: async () => ({ ok: true, prs: open, ...(more ? { more } : {}) }),
    viewer: async () => (opts.viewer === undefined ? 'me' : opts.viewer),
    discussion: async () => ({ ok: true, discussion: { threads: [], reviews: [], comments: [] } }),
    ...opts.host,
  };
  const prepare = vi.fn(async (_path: string, _host: GitHost, p: { number: number }): Promise<{ ok: true } & PreparedPr> =>
    prepared(`sha${p.number}`),
  );
  const changed = vi.fn();
  const dropRef = vi.fn(async () => undefined);
  let now = new Date('2026-11-02T10:00:00');
  const activity = createActivityLog({ now: () => now.getTime() });
  const queue = createReviewQueue({
    projects: () => [{ alias: 'api', path: '/repos/api', mode: opts.mode ?? 'all' }],
    hostOf: () => host,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    prepare,
    dropRef,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.agentInCheckout ? { agentInCheckout: opts.agentInCheckout, checkoutLines: opts.checkoutLines ?? (() => AGENT_LINES) } : {}),
    ...(opts.sweepTrees ? { sweepTrees: opts.sweepTrees } : {}),
    store,
    limits: () => ({ maxPerDay: opts.maxPerDay === undefined ? 10 : opts.maxPerDay, maxLines: opts.maxLines ?? 3000 }),
    changed,
    now: () => now,
    activity,
  });
  const notes = () => activity.snapshot().recent.flatMap((r) => r.notes.map((n) => `${n.level}: ${n.text}`));
  return {
    queue,
    rows,
    prepare,
    changed,
    dropRef,
    notes,
    activity,
    setOpen: (p: OpenPr[]) => void (open = p),
    setMore: (m: boolean) => void (more = m),
    setNow: (d: Date) => void (now = d),
  };
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
    expect(r).not.toHaveProperty('fork');
    await h.queue.sweep(); // the same head: not again
    expect(h.prepare).toHaveBeenCalledTimes(1);
    h.setOpen([pr(7, { headSha: 'sha7b' })]); // a push: again
    await h.queue.sweep();
    expect(h.prepare).toHaveBeenCalledTimes(2);
    // A fork's PR: its review says so (Fix it myself refuses it).
    h.setOpen([pr(7, { headSha: 'sha7c', fork: true })]);
    await h.queue.sweep();
    expect(h.rows.get('api#7')!.fork).toBe(true);
  });

  it('a push seen: the review is queued again, but its head stays the one its lines were read at until it is prepared', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.prepare.mockImplementationOnce(async () => prepared('sha7'));
    await h.queue.sweep();
    expect(h.rows.get('api#7')).toMatchObject({ status: 'ready', headSha: 'sha7' });
    h.prepare.mockImplementationOnce(async () => {
      await gate;
      return prepared('sha7b');
    });
    h.setOpen([pr(7, { headSha: 'sha7b' })]);
    const sweeping = h.queue.sweep();
    await new Promise((r) => setTimeout(r, 5));
    // Queued or running for the new push: files, lines and drafts are still the old diff's, and so is the head.
    expect(h.rows.get('api#7')).toMatchObject({ headSha: 'sha7', listedHead: 'sha7b' });
    expect(['queued', 'running']).toContain(h.rows.get('api#7')!.status);
    release();
    await sweeping;
    expect(h.rows.get('api#7')).toMatchObject({ status: 'ready', headSha: 'sha7b' });
    // Never prepared: the listed head is all there is.
    expect(withStatus(null, { ...pr(9), repo: 'api' }, 'queued', null, new Date()).headSha).toBe('sha9');
  });

  it('a fetched head that is not the listed one (an Azure DevOps merge ref, a push meanwhile) is not prepared again each sweep', async () => {
    const h = harness();
    h.prepare.mockImplementation(async () => prepared('fetched-tip'));
    await h.queue.sweep();
    expect(h.rows.get('api#7')).toMatchObject({ status: 'ready', headSha: 'fetched-tip', listedHead: 'sha7' });
    await h.queue.sweep();
    await h.queue.sweep();
    expect(h.prepare).toHaveBeenCalledTimes(1);
  });

  it('the AI step: its stories and drafts, a note off the diff set aside; an unusable answer falls back to folders and says so', async () => {
    const answer = JSON.stringify({
      stories: [{ title: 'Adds refunds', why: 'w', risk: 'money', riskLevel: 4, flags: ['security'], files: ['src/Refunds.cs'] }],
      notes: [
        { path: 'src/Refunds.cs', line: 2, body: 'Negative amounts?' },
        { path: 'src/Refunds.cs', line: 40, body: 'Off the diff.' },
      ],
    });
    const agent = vi.fn(async (_prompt: string) => answer);
    const h = harness({ agent });
    await h.queue.sweep();
    const r = h.rows.get('api#7')!;
    expect(agent.mock.calls[0][0]).toContain('src/Refunds.cs'); // only the Logic file is shown
    expect(agent.mock.calls[0][0]).not.toContain('package-lock.json');
    expect(r.aiStep).toBe('done');
    expect(r.stories[0]).toMatchObject({ title: 'Adds refunds', flags: ['security', 'no-tests'], by: 'ai' });
    expect(r.drafts).toEqual([{ id: 'd1', path: 'src/Refunds.cs', line: 2, body: 'Negative amounts?', state: 'draft', by: 'ai' }]);
    // A note on a line the diff doesn't show is set aside with its text, not a draft the host would refuse.
    expect(r.dropped).toEqual([
      {
        path: 'src/Refunds.cs',
        line: 40,
        body: 'Off the diff.',
        by: 'ai',
        why: "line 40 isn't in the diff, so it can't be a comment there",
      },
    ]);

    const bad = harness({ agent: async () => 'no idea' });
    await bad.queue.sweep();
    expect(bad.rows.get('api#7')).toMatchObject({ aiStep: 'failed', why: 'the AI step gave no usable answer: stories are by folder' });
  });

  it('a PR over the size limit, or past the day’s cap, waits — with why; a click prepares it anyway', async () => {
    const big = harness({ prs: [pr(8, { additions: 4000 })], maxLines: 0 });
    await big.queue.sweep();
    expect(big.rows.get('api#8')).toMatchObject({
      status: 'waiting',
      held: 'size',
      // The lock file's lines don't count: one line of code to read.
      why: '1 changed line to read (of 3): over the size limit (0), so it waits for your click',
    });
    await big.queue.sweep(); // held at this head: not fetched again
    expect(big.prepare).toHaveBeenCalledTimes(1);
    expect(await big.queue.runNow('api', 8)).toMatchObject({ ok: true, review: { status: 'ready' } });
    expect(big.rows.get('api#8')!.held).toBeUndefined();

    const capped = harness({ prs: [pr(1), pr(2)], maxPerDay: 1 });
    await capped.queue.sweep();
    expect([capped.rows.get('api#1')!.status, capped.rows.get('api#2')!.status]).toEqual(['ready', 'waiting']);
    expect(capped.rows.get('api#2')).toMatchObject({ held: 'cap', why: expect.stringContaining("today's 1 automatic reviews are done") });
  });

  it("the limit counts only the lines worth reading: a migration's designer doesn't — the user's #3653", async () => {
    const designer = `diff --git a/src/Migrator/Migrations/20261106_AddTerms.Designer.cs b/src/Migrator/Migrations/20261106_AddTerms.Designer.cs
new file mode 100644
index 0000000..1
--- /dev/null
+++ b/src/Migrator/Migrations/20261106_AddTerms.Designer.cs
@@ -0,0 +1,6 @@
+a
+b
+c
+d
+e
+f
`;
    const withDesigner = async (_p: string, _h: GitHost, p: { number: number }) => ({
      ...prepared(`sha${p.number}`),
      files: parseGitDiff(DIFF + designer),
    });
    // Listed at 23,864 lines; fetched, 9 changed — 6 the designer, 2 the lock file: 1 to read, within the limit.
    const h = harness({ prs: [pr(3653, { additions: 23835, deletions: 29 })], maxLines: 1 });
    h.prepare.mockImplementation(withDesigner);
    await h.queue.sweep();
    expect(h.rows.get('api#3653')).toMatchObject({ status: 'ready' });
    // The designer file is left out of the review altogether: not among its files, named apart, in its size.
    const r = h.rows.get('api#3653')!;
    expect(r.files.map((f) => f.path)).not.toContain('src/Migrator/Migrations/20261106_AddTerms.Designer.cs');
    expect(r.ignored).toEqual([
      { path: 'src/Migrator/Migrations/20261106_AddTerms.Designer.cs', why: 'designer file', added: 6, deleted: 0 },
    ]);
    expect(r.size).toEqual({ files: 3, added: 8, deleted: 1 });
    // Over it even so: held, saying how many of the lines count.
    const held = harness({ prs: [pr(3653, { additions: 23835, deletions: 29 })], maxLines: 0 });
    held.prepare.mockImplementation(withDesigner);
    await held.queue.sweep();
    expect(held.rows.get('api#3653')).toMatchObject({
      status: 'waiting',
      held: 'size',
      why: '1 changed line to read (of 9): over the size limit (0), so it waits for your click',
    });
  });

  it('one held for its size by the list alone, from before (never fetched), is fetched again', () => {
    const was = {
      status: 'waiting',
      held: 'size',
      headSha: 'h',
      listedHead: 'h',
      size: { files: 0, added: 23835, deleted: 29 },
    } as PrReviewWire;
    expect(upToDate(was, pr(1, { headSha: 'h' }), new Date(), false)).toBe(false);
    expect(upToDate({ ...was, size: { files: 12, added: 23835, deleted: 29 } }, pr(1, { headSha: 'h' }), new Date(), false)).toBe(true);
  });

  it('one held by the day’s cap is prepared on a later day, as its message says', async () => {
    const h = harness({ prs: [pr(1), pr(2)], maxPerDay: 1 });
    await h.queue.sweep();
    await h.queue.sweep(); // the same day: still held
    expect(h.rows.get('api#2')!.status).toBe('waiting');
    expect(h.prepare).toHaveBeenCalledTimes(1);
    h.setNow(new Date('2026-11-03T09:00:00'));
    await h.queue.sweep();
    expect(h.rows.get('api#2')!.status).toBe('ready');
    expect(h.rows.get('api#2')!.held).toBeUndefined();
    expect(h.prepare).toHaveBeenCalledTimes(2);
  });

  it('a host whose list has no size: the limit applies to the fetched diff, once per head; a click prepares it', async () => {
    const h = harness({ prs: [pr(5, { additions: 0, deletions: 0 })], maxLines: 0 });
    await h.queue.sweep();
    expect(h.rows.get('api#5')).toMatchObject({
      status: 'waiting',
      held: 'size',
      size: { files: 2, added: 2, deleted: 1 },
      why: '1 changed line to read (of 3): over the size limit (0), so it waits for your click',
    });
    await h.queue.sweep(); // the same head: not fetched again
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.notes()).toContain('info: api #5: 1 changed line to read (of 3): over the size limit (0), so it waits for your click');
    expect(await h.queue.runNow('api', 5)).toMatchObject({ ok: true, review: { status: 'ready' } });
  });

  it('a project set to off is never swept, and reviews of PRs no longer open go — with their fetched code', async () => {
    const off = harness({ mode: 'off' });
    await off.queue.sweep();
    expect(off.rows.size).toBe(0);

    const h = harness({ prs: [pr(1), pr(2)] });
    await h.queue.sweep();
    h.setOpen([pr(2)]);
    await h.queue.sweep();
    expect([...h.rows.keys()]).toEqual(['api#2']);
    expect(h.dropRef).toHaveBeenCalledWith('/repos/api', 1);
    expect(h.notes()).toContain('info: 1 review of PRs no longer open dropped');
  });

  it('a list at its limit drops no review (an open PR past it is not closed), and says so', async () => {
    const h = harness({ prs: [pr(1), pr(2)] });
    await h.queue.sweep();
    h.setOpen([pr(2)]);
    h.setMore(true);
    await h.queue.sweep();
    expect([...h.rows.keys()].sort()).toEqual(['api#1', 'api#2']);
    expect(h.dropRef).not.toHaveBeenCalled();
    expect(h.notes()).toContain('warn: api: more open PRs than one listing returns; keeping the reviews of those not listed');
  });

  it('who you are unknown: the project waits for the next sweep (never your own PRs, never every asked one skipped)', async () => {
    const h = harness({ prs: [pr(1, { author: 'me' }), pr(2)], viewer: null });
    await h.queue.sweep();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.rows.size).toBe(0);
    expect(h.notes()).toContain("warn: api: couldn't tell who you are on GitHub; its PRs wait for the next sweep");
  });

  it('a listing that fails keeps every review; why each PR is left out is noted', async () => {
    const h = harness({ prs: [pr(1), pr(2, { isDraft: true })] });
    await h.queue.sweep();
    expect(h.notes()).toContain('info: api: left out #2 (a draft)');
    const failing = harness({ prs: [pr(1)], host: { openPrs: async () => ({ ok: false, error: 'gh: 502' }) } });
    failing.rows.set('api#1', withStatus(null, { ...pr(1), repo: 'api' }, 'ready', null, new Date()));
    await failing.queue.sweep();
    expect([...failing.rows.keys()]).toEqual(['api#1']);
    expect(failing.notes()).toContain("warn: api: couldn't list its open PRs (gh: 502); keeping what it had");
  });

  it('a prepare that fails is recorded as failed with the reason; runNow refuses a PR that isn’t open', async () => {
    const h = harness();
    h.prepare.mockResolvedValueOnce({ ok: false, error: "couldn't fetch the PR's code: denied" } as never);
    await h.queue.sweep();
    expect(h.rows.get('api#7')).toMatchObject({ status: 'failed', why: "couldn't fetch the PR's code: denied" });
    expect(h.notes()).toContain("warn: api #7: couldn't prepare it (couldn't fetch the PR's code: denied)");
    expect(await h.queue.runNow('api', 99)).toEqual({ ok: false, error: "#99 isn't an open pull request of api" });
    expect(await h.queue.runNow('web', 1)).toEqual({ ok: false, error: "web isn't one of your repos" });
  });

  it('anything that throws while preparing ends the row failed, never left running', async () => {
    const h = harness({ agent: async () => null });
    h.prepare.mockResolvedValueOnce({ ok: true, files: null, extras: null, mergeBase: 'mb', headSha: 'x' } as never);
    await h.queue.sweep();
    expect(h.rows.get('api#7')).toMatchObject({ status: 'failed', why: expect.stringContaining("couldn't prepare it:") });
  });

  it('a review left running by a run that stopped is prepared again; a fresh running one (another run’s) is left alone', async () => {
    const h = harness();
    h.rows.set('api#7', withStatus(null, { ...pr(7), repo: 'api' }, 'running', null, new Date('2026-11-02T09:00:00')));
    await h.queue.sweep();
    expect(h.rows.get('api#7')!.status).toBe('ready');
    expect(h.notes()).toContain('warn: api #7: left preparing by a run that stopped; again');
    const fresh = withStatus(null, { ...pr(7), repo: 'api' }, 'running', null, new Date('2026-11-02T09:59:00'));
    expect(upToDate(fresh, pr(7), new Date('2026-11-02T10:00:00'), false)).toBe(true);
  });

  it('prepared again: your drafts on lines still in the diff stay, the rest are set aside with their text; what you submitted stays', async () => {
    const answer = JSON.stringify({
      stories: [{ title: 'Refunds', why: 'w', risk: 'r', riskLevel: 3, flags: [], files: ['src/Refunds.cs'] }],
      notes: [{ path: 'src/Refunds.cs', line: 2, body: 'AI again' }],
    });
    const h = harness({ agent: async () => answer });
    await h.queue.sweep();
    const r = h.rows.get('api#7')!;
    h.rows.set('api#7', {
      ...r,
      drafts: [
        { ...r.drafts[0], state: 'posted' },
        { id: 'u1', path: 'src/Refunds.cs', line: 3, body: 'mine, still on the diff', state: 'draft', by: 'you' },
        { id: 'u2', path: 'src/Gone.cs', line: 1, body: 'mine, its file gone', state: 'draft', by: 'you' },
      ],
      submitted: { at: '2026-11-02T10:00:00.000Z', event: 'comment' },
    });
    h.setOpen([pr(7, { headSha: 'sha7b' })]);
    await h.queue.sweep();
    const again = h.rows.get('api#7')!;
    expect(again.drafts.map((d) => [d.id, d.state, d.body])).toEqual([
      ['d1', 'posted', 'AI again'],
      ['u1', 'draft', 'mine, still on the diff'],
      ['d3', 'draft', 'AI again'], // past every id the review had (u2 included): never one handed out before
    ]);
    expect(again.dropped).toEqual([
      { path: 'src/Gone.cs', line: 1, body: 'mine, its file gone', by: 'you', why: "src/Gone.cs isn't changed by the PR any more" },
    ]);
    expect(again.submitted).toEqual({ at: '2026-11-02T10:00:00.000Z', event: 'comment' });
  });

  it('one review at a time — the sweep and your clicks — and one sweep at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ prs: [pr(1), pr(2)] });
    let running = 0;
    let most = 0;
    h.prepare.mockImplementation(async (_path, _host, p) => {
      most = Math.max(most, ++running);
      await gate;
      running--;
      return prepared(`sha${p.number}`);
    });
    const a = h.queue.sweep();
    const b = h.queue.sweep();
    expect(b).toBe(a); // the second asker gets the sweep that runs
    const click = h.queue.runNow('api', 1);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([a, click]);
    expect(most).toBe(1);
    // One sweep's run (the click has its own, saying how it was read).
    expect(h.activity.snapshot().recent.filter((r) => r.kind === 'reviews' && r.label === 'Preparing PR reviews')).toHaveLength(1);
    // #1 is the click's: the sweep, finding it being prepared, leaves it alone.
    expect(h.prepare.mock.calls.map((c) => c[2].number)).toEqual([1, 2]);
    expect(h.rows.get('api#1')!.status).toBe('ready');
    expect(h.notes().filter((n) => n.startsWith('action: api #'))).toEqual([
      'action: api #2: prepared — 1 story, 1 untested change (no agent for the AI step: stories are by folder)',
    ]);
  });
});

describe('the AI step in a temporary checkout of the PR', () => {
  const answer = JSON.stringify({
    stories: [{ title: 'Adds refunds', why: 'w', risk: 'money', riskLevel: 4, flags: [], files: ['src/Refunds.cs'] }],
  });

  it('read in a checkout at the fetched head, told so in the prompt; the diff-only run is not asked; Activity says which', async () => {
    const agent = vi.fn(async (_p: string) => 'unused');
    const agentInCheckout = vi.fn(async () => ({ answer }));
    const h = harness({ agent, agentInCheckout });
    await h.queue.sweep();
    expect(agentInCheckout).toHaveBeenCalledTimes(1);
    const [at, prompt] = agentInCheckout.mock.calls[0] as unknown as [unknown, string];
    expect(at).toEqual({ repoPath: '/repos/api', alias: 'api', number: 7, headSha: 'sha7' });
    for (const line of [...AGENT_LINES, ...CHECKOUT_LINES]) expect(prompt).toContain(line);
    expect(prompt).toContain('src/Refunds.cs');
    expect(agent).not.toHaveBeenCalled();
    expect(h.rows.get('api#7')).toMatchObject({ aiStep: 'done', stories: [expect.objectContaining({ title: 'Adds refunds', by: 'ai' })] });
    expect(h.notes()).toContain('action: api #7: prepared — 1 story, 1 untested change; read in a temporary checkout of the PR');
  });

  it('an agent with no read-only mode (null), or a checkout run with no answer: the diff alone, without the checkout lines, and why', async () => {
    const agent = vi.fn(async (_p: string) => answer);
    const none = harness({ agent, agentInCheckout: async () => null });
    await none.queue.sweep();
    expect(agent.mock.calls[0][0]).not.toContain(CHECKOUT_LINES[0]);
    expect(none.rows.get('api#7')!.aiStep).toBe('done');
    expect(none.notes()).toContain(
      'action: api #7: prepared — 1 story, 1 untested change; read from the diff alone (the agent has no read-only mode)',
    );
    const failed = harness({ agent, agentInCheckout: async () => ({ answer: null, why: 'timed out' }) });
    await failed.queue.sweep();
    expect(failed.rows.get('api#7')!.aiStep).toBe('done');
    expect(failed.notes()).toContain(
      'action: api #7: prepared — 1 story, 1 untested change; read from the diff alone (the checkout run gave no answer: timed out)',
    );
    const threw = harness({
      agent,
      agentInCheckout: async () => {
        throw new Error('disk full');
      },
    });
    await threw.queue.sweep();
    expect(threw.notes().some((n) => n.endsWith('(the checkout run gave no answer: disk full)'))).toBe(true);
  });

  it('a checkout run that answered but whose checkout would not go: its note is kept in Activity (F005)', async () => {
    const agent = vi.fn(async (_p: string) => 'unused');
    const why = "its checkout /t/api-7-sha7-x wouldn't go: the next start sweeps it";
    const h = harness({ agent, agentInCheckout: async () => ({ answer, why }) });
    await h.queue.sweep();
    expect(agent).not.toHaveBeenCalled();
    expect(h.rows.get('api#7')!.aiStep).toBe('done');
    expect(h.notes()).toContain(`action: api #7: prepared — 1 story, 1 untested change; read in a temporary checkout of the PR (${why})`);
  });

  it("an installed agent its read-only mode wasn't measured on: no checkout run, the diff alone, and Activity says why (decision 1)", async () => {
    const agent = vi.fn(async (_p: string) => answer);
    const why = 'no checkout run: Claude Code 2.1.200 is older than 2.1.317, the version its read-only flags were measured on';
    const h = harness({ agent, agentInCheckout: async () => ({ answer: null, skipped: true, why }) });
    await h.queue.sweep();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent.mock.calls[0][0]).not.toContain(CHECKOUT_LINES[0]);
    expect(h.rows.get('api#7')!.aiStep).toBe('done');
    expect(h.notes()).toContain(`action: api #7: prepared — 1 story, 1 untested change; read from the diff alone (${why})`);
  });

  it("an agent with no read-only words (no read-only run): the checkout isn't made, the diff alone (#64 F005)", async () => {
    const agent = vi.fn(async (_p: string) => answer);
    const agentInCheckout = vi.fn(async () => ({ answer }));
    const h = harness({ agent, agentInCheckout, checkoutLines: () => null });
    await h.queue.sweep();
    expect(agentInCheckout).not.toHaveBeenCalled();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(h.notes().some((n) => n.endsWith('read from the diff alone (the agent has no read-only mode)'))).toBe(true);
  });

  it('no agent at all: neither run is asked (stories by folder)', async () => {
    const agentInCheckout = vi.fn(async () => ({ answer }));
    const h = harness({ agentInCheckout });
    await h.queue.sweep();
    expect(agentInCheckout).not.toHaveBeenCalled();
    expect(h.rows.get('api#7')!.stories[0].by).toBe('folder');
  });

  it('a click (runNow) says in Activity how it was read', async () => {
    const h = harness({ agent: async () => answer, agentInCheckout: async () => ({ answer }) });
    const r = await h.queue.runNow('api', 7);
    expect(r).toMatchObject({ ok: true });
    expect(Object.keys(r)).toEqual(['ok', 'review']);
    const run = h.activity.snapshot().recent.find((x) => x.label === 'Preparing the review of api #7');
    expect(run).toMatchObject({ kind: 'reviews', summary: 'prepared; read in a temporary checkout of the PR' });
  });

  it('leftover checkouts are swept once, at the first sweep, and said in Activity', async () => {
    const sweepTrees = vi.fn(async () => ({ swept: ['api-3-abc'], failed: ['web-4-def'] }));
    const h = harness({ sweepTrees });
    await h.queue.sweep();
    await h.queue.sweep();
    expect(sweepTrees).toHaveBeenCalledTimes(1);
    expect(h.notes()).toContain('action: removed 1 temporary PR checkout a stopped run left: api-3-abc');
    expect(h.notes()).toContain("warn: couldn't remove 1 temporary PR checkout: web-4-def");
  });
});

describe("the PR's existing discussion (#64)", () => {
  const talk = (updatedAt?: string) => ({
    ...(updatedAt ? { updatedAt } : {}),
    threads: [
      {
        id: 'T1',
        path: 'src/Orders/Refund.cs',
        line: 3,
        side: 'right' as const,
        outdated: false,
        resolved: false,
        comments: [{ author: 'ivo', association: 'MEMBER', body: 'Lock the row here.', at: '2026-11-01T10:00:00Z' }],
      },
    ],
    reviews: [{ author: 'ana', state: 'approved' as const, body: '', at: '2026-11-01T11:00:00Z' }],
    comments: [],
  });

  it('is read when the review is prepared, given to the AI step fenced as data, and stored with the review', async () => {
    const discussion = vi.fn(async () => ({ ok: true as const, discussion: talk('2026-11-01T12:00:00Z') }));
    const prompts: string[] = [];
    const h = harness({
      host: { discussion },
      agent: async (p) => {
        prompts.push(p);
        return null;
      },
    });
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(1);
    const r = h.rows.get(reviewKey('api', 7))!;
    expect(r.discussion).toMatchObject({
      updatedAt: '2026-11-01T12:00:00Z',
      at: new Date('2026-11-02T10:00:00').toISOString(),
      threads: [{ id: 'T1' }],
    });
    const p = prompts[0];
    expect(p).toContain('Do not add a note that makes a point a reviewer already made');
    const data = p.slice(p.indexOf('<<<'), p.lastIndexOf('>>>'));
    expect(data).toContain('Discussion:');
    expect(data).toContain('Lock the row here.');
    expect(p.slice(0, p.indexOf('<<<'))).not.toContain('Lock the row here.');
  });

  it("is read again only when the PR moved on the host (its list's updatedAt), not on every sweep", async () => {
    const discussion = vi.fn(async () => ({ ok: true as const, discussion: talk() }));
    const h = harness({ host: { discussion }, prs: [pr(7, { updatedAt: '2026-11-01T12:00:00Z' })] });
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(1);
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(1);
    h.setOpen([pr(7, { updatedAt: '2026-11-02T09:00:00Z' })]);
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(2);
    expect(h.rows.get(reviewKey('api', 7))!.discussion?.updatedAt).toBe('2026-11-02T09:00:00Z');
    // Prepared once: a moved PR reads its discussion, never prepares again for the same head.
    expect(h.prepare).toHaveBeenCalledTimes(1);
  });

  it('a host that can say nothing of updatedAt: read again once it is half an hour old', async () => {
    const discussion = vi.fn(async () => ({ ok: true as const, discussion: talk() }));
    const h = harness({ host: { discussion } });
    await h.queue.sweep();
    h.setNow(new Date('2026-11-02T10:20:00'));
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(1);
    h.setNow(new Date('2026-11-02T10:31:00'));
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(2);
  });

  it("the host's API limit: the last read stays, and the host is asked for none for 10 minutes", async () => {
    let limited = false;
    const discussion = vi.fn(async () =>
      limited ? { ok: false as const, error: 'API rate limit already exceeded' } : { ok: true as const, discussion: talk() },
    );
    const h = harness({ host: { discussion } });
    await h.queue.sweep();
    limited = true;
    h.setNow(new Date('2026-11-02T11:00:00'));
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(2);
    expect(h.rows.get(reviewKey('api', 7))!.discussion?.threads).toHaveLength(1);
    expect(h.notes().some((n) => n.startsWith('warn:') && n.includes('resting 10 min'))).toBe(true);
    // Resting: not asked, even on open.
    expect((await h.queue.refreshDiscussion('api', 7)).ok).toBe(true);
    h.setNow(new Date('2026-11-02T11:05:00'));
    await h.queue.sweep();
    expect(discussion).toHaveBeenCalledTimes(2);
    limited = false;
    h.setNow(new Date('2026-11-02T11:11:00'));
    await h.queue.refreshDiscussion('api', 7);
    expect(discussion).toHaveBeenCalledTimes(3);
  });

  it('on open: read again at most once a minute; the review as it stands otherwise', async () => {
    const discussion = vi.fn(async () => ({ ok: true as const, discussion: talk() }));
    const h = harness({ host: { discussion } });
    await h.queue.sweep();
    const r = await h.queue.refreshDiscussion('api', 7);
    expect(r.ok && r.review.discussion?.threads).toHaveLength(1);
    expect(discussion).toHaveBeenCalledTimes(1);
    h.setNow(new Date('2026-11-02T10:02:00'));
    await h.queue.refreshDiscussion('api', 7);
    expect(discussion).toHaveBeenCalledTimes(2);
    expect(await h.queue.refreshDiscussion('api', 99)).toEqual({ ok: false, error: 'no review of api #99' });
  });

  it('a read that fails at prepare time keeps the last one (carried forward), and says so', async () => {
    let fail = false;
    const discussion = vi.fn(async () => (fail ? { ok: false as const, error: 'gh: 502' } : { ok: true as const, discussion: talk() }));
    const h = harness({ host: { discussion } });
    await h.queue.sweep();
    fail = true;
    h.setOpen([pr(7, { headSha: 'sha7b' })]);
    await h.queue.sweep();
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.rows.get(reviewKey('api', 7))!.discussion?.threads).toHaveLength(1);
    expect(h.notes().some((n) => n.includes("couldn't read its discussion (gh: 502); the last read stays"))).toBe(true);
  });
});
