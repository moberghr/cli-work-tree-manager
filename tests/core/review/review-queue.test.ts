import { describe, expect, it, vi } from 'vitest';
import {
  candidates,
  createReviewQueue,
  upToDate,
  withStatus,
  type ReviewProject,
  type ReviewStore,
} from '../../../src/core/review/review-queue.js';
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

function harness(
  opts: {
    prs?: OpenPr[];
    agent?: (p: string) => Promise<string | null>;
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
    await h.queue.sweep(); // the same head: not again
    expect(h.prepare).toHaveBeenCalledTimes(1);
    h.setOpen([pr(7, { headSha: 'sha7b' })]); // a push: again
    await h.queue.sweep();
    expect(h.prepare).toHaveBeenCalledTimes(2);
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
    const big = harness({ prs: [pr(8, { additions: 4000 })], maxLines: 3000 });
    await big.queue.sweep();
    expect(big.rows.get('api#8')).toMatchObject({
      status: 'waiting',
      held: 'size',
      why: expect.stringContaining('over the size limit (3000)'),
    });
    expect(big.prepare).not.toHaveBeenCalled();
    expect(await big.queue.runNow('api', 8)).toMatchObject({ ok: true, review: { status: 'ready' } });
    expect(big.rows.get('api#8')!.held).toBeUndefined();

    const capped = harness({ prs: [pr(1), pr(2)], maxPerDay: 1 });
    await capped.queue.sweep();
    expect([capped.rows.get('api#1')!.status, capped.rows.get('api#2')!.status]).toEqual(['ready', 'waiting']);
    expect(capped.rows.get('api#2')).toMatchObject({ held: 'cap', why: expect.stringContaining("today's 1 automatic reviews are done") });
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
    const h = harness({ prs: [pr(5, { additions: 0, deletions: 0 })], maxLines: 2 });
    await h.queue.sweep();
    expect(h.rows.get('api#5')).toMatchObject({
      status: 'waiting',
      held: 'size',
      size: { files: 2, added: 2, deleted: 1 },
      why: '3 changed lines: over the size limit (2), so it waits for your click',
    });
    await h.queue.sweep(); // the same head: not fetched again
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.notes()).toContain('info: api #5: 3 changed lines: over the size limit (2), so it waits for your click');
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
    expect(h.activity.snapshot().recent.filter((r) => r.kind === 'reviews')).toHaveLength(1);
    // #1 is the click's: the sweep, finding it being prepared, leaves it alone.
    expect(h.prepare.mock.calls.map((c) => c[2].number)).toEqual([1, 2]);
    expect(h.rows.get('api#1')!.status).toBe('ready');
    expect(h.notes().filter((n) => n.startsWith('action: api #'))).toEqual([
      'action: api #2: prepared — 1 story, 1 untested change (no agent for the AI step: stories are by folder)',
    ]);
  });
});
