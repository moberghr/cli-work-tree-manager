import type { CommandRunner } from '../platform/command-runner.js';
import type { GitHost, HostResult, OpenPr } from '../hosts/types.js';
import type { PrReviewWire, ReviewMode, ReviewStatus } from '../api-types.js';
import type { ActivityLog } from '../platform/activity.js';
import type { KindRule } from './change-kinds.js';
import type { PreparedPr } from './review-source.js';
import type { ReviewTreeAt } from './review-tree.js';
import { buildReview, kindsOf, reviewPrompt, type ReviewMeta } from './review-build.js';
import { carryForward, isStaleRunning, preparedOn } from './review-submit.js';

/**
 * The review queue (#64): which open PRs get a review prepared, and when.
 * Policy with its I/O passed in (work web wires git, the host, the agent,
 * state.db).
 *
 * - Per project (a repo or a group, config `reviews.projects`): `all` open
 *   PRs (the default), only those `asked` of you by name, or `off`. Never
 *   your own PRs, never drafts: a review is for what others ask you to read.
 * - A review is for one head commit — the one the host's list names
 *   (`listedHead`): a new push queues it again; the same head is never done
 *   twice. Your drafts, what you posted and submitted carry over to the
 *   review prepared again (`carryForward`).
 * - Automatic reviews spend the user's agent plan: one at a time, at most
 *   `maxPerDay` a day when config sets one (one held by the cap is picked up
 *   when the day allows), and a PR over `maxLines` changed lines waits for a
 *   click — by the list's size, or, for a host whose list has none, the
 *   fetched diff's (`runNow` ignores both: the user asked).
 * - Who you are must be known: without it the project is left for that
 *   sweep (your own PRs would be reviewed, or every `asked` one skipped).
 * - Reviews of PRs no longer open go, with their fetched code — only from a
 *   complete list (one at its limit drops nothing).
 * - A review left `running` (work web stopped meanwhile) is prepared again.
 * Each decision is noted in the Activity panel with its reason.
 */

export interface ReviewProject {
  alias: string;
  path: string;
  mode: ReviewMode;
}

export interface ReviewStore {
  read(repo: string, number: number): PrReviewWire | null;
  /** Read and write one review in one transaction: `change` gets what is stored (null: none). */
  upsert(repo: string, number: number, change: (was: PrReviewWire | null) => PrReviewWire): PrReviewWire;
  all(): PrReviewWire[];
  /** Drop the reviews of PRs no longer open (repos asked only): the ones dropped. */
  keepOnly(repos: string[], open: Set<string>): Array<{ repo: string; number: number }>;
}

export interface ReviewQueueDeps {
  projects: () => ReviewProject[];
  hostOf: (repoPath: string) => GitHost;
  run: CommandRunner;
  prepare: (repoPath: string, host: GitHost, pr: { number: number; base: string }) => Promise<HostResult<PreparedPr>>;
  /** A review gone: its fetched code goes too (`refs/work/review/<n>`). */
  dropRef?: (repoPath: string, number: number) => Promise<void>;
  /** The summarising agent's one-shot run (`runInternal`); absent: no AI step, stories by folder. */
  agent?: (prompt: string) => Promise<string | null>;
  /**
   * The AI step read-only in a temporary checkout of the PR at its head (review-tree.ts, `runInternalReadOnly`),
   * tried before `agent`: null when the agent has no read-only mode; `answer` null when the run gave none (`why`) —
   * either way `agent` then reads the diff alone.
   */
  agentInCheckout?: (at: ReviewTreeAt, prompt: string) => Promise<{ answer: string | null; why?: string } | null>;
  /** Remove the temporary checkouts a stopped run left: once, before the first sweep's reviews (review-tree.ts). */
  sweepTrees?: () => Promise<{ swept: string[]; failed: string[] }>;
  rules?: () => KindRule[];
  store: ReviewStore;
  /** `maxPerDay` null: no daily cap. */
  limits: () => { maxPerDay: number | null; maxLines: number };
  /** Something changed: tell the dashboard. */
  changed: () => void;
  now?: () => Date;
  activity?: ActivityLog;
}

export interface ReviewQueue {
  /** Look at every project's open PRs, queue what's new, and prepare the queue. */
  sweep(): Promise<void>;
  /** Prepare this PR now (the user's click): whatever its size, whatever the day's count. */
  runNow(repo: string, number: number): Promise<HostResult<{ review: PrReviewWire }>>;
}

/** A review not prepared yet: what is known of the PR, and where it stands. Pure. */
export function placeholder(meta: ReviewMeta, status: ReviewStatus, why: string | null, now: Date, size?: OpenPr): PrReviewWire {
  return {
    ...meta,
    listedHead: meta.headSha,
    status,
    why,
    at: now.toISOString(),
    size: { files: 0, added: size?.additions ?? 0, deleted: size?.deletions ?? 0 },
    files: [],
    tests: { list: [], counts: { added: 0, changed: 0, removed: 0, skipped: 0 }, gaps: [], covers: {}, unitOnlyForSchema: false },
    stories: [],
    unstoried: [],
    drafts: [],
    asserts: {},
    aiStep: 'none',
  };
}

/**
 * A review's new status, keeping what it holds (your drafts, what you submitted) until it's prepared again: only
 * where it stands, for which head, and why it waits change. Pure.
 */
export function withStatus(
  was: PrReviewWire | null,
  meta: ReviewMeta,
  status: ReviewStatus,
  why: string | null,
  now: Date,
  opts: { size?: OpenPr; held?: PrReviewWire['held']; diffSize?: PrReviewWire['size'] } = {},
): PrReviewWire {
  if (!was) {
    const fresh = placeholder(meta, status, why, now, opts.size);
    return { ...fresh, ...(opts.diffSize ? { size: opts.diffSize } : {}), ...(opts.held ? { held: opts.held } : {}) };
  }
  const { held: _old, ...rest } = was;
  return {
    ...rest,
    ...meta,
    // The head a prepared review was read at stays while its content (files, lines, drafts) stands, until it's
    // prepared again: a submit goes at the commit its lines are from. The listed one is what a sweep compares.
    headSha: was.preparedAt ? was.headSha : meta.headSha,
    listedHead: meta.headSha,
    status,
    why,
    at: now.toISOString(),
    // The list's size for the new head, when it has one (Azure DevOps' says nothing: the last known stays).
    ...(opts.diffSize
      ? { size: opts.diffSize }
      : opts.size && opts.size.additions + opts.size.deletions > 0
        ? { size: { files: was.size.files, added: opts.size.additions, deleted: opts.size.deletions } }
        : {}),
    ...(opts.held ? { held: opts.held } : {}),
  };
}

/** Which of a project's open PRs it reviews, and why the rest aren't. Pure. */
export function candidates(
  prs: OpenPr[],
  mode: ReviewMode,
  viewer: string | null,
): { take: OpenPr[]; left: Array<{ pr: OpenPr; why: string }> } {
  const me = viewer?.toLowerCase() ?? null;
  const take: OpenPr[] = [];
  const left: Array<{ pr: OpenPr; why: string }> = [];
  for (const pr of prs) {
    if (mode === 'off') left.push({ pr, why: 'reviews are off for this project' });
    else if (pr.isDraft) left.push({ pr, why: 'a draft' });
    else if (me && pr.author.toLowerCase() === me) left.push({ pr, why: 'your own' });
    else if (mode === 'asked' && !(me && pr.requested.some((r) => r.toLowerCase() === me)))
      left.push({ pr, why: "doesn't ask for your review (this project reviews only those)" });
    else take.push(pr);
  }
  return { take, left };
}

/**
 * A stored review still stands for this listed PR: nothing to do. The same head (as listed, or as fetched) prepared,
 * failed, or waiting for your click — not one queued, one held only by a day's cap, or one left running by a run
 * that stopped. Pure.
 */
export function upToDate(was: PrReviewWire | null, pr: OpenPr, now: Date, active: boolean): boolean {
  if (!was) return false;
  const same = (was.listedHead ?? was.headSha) === pr.headSha || was.headSha === pr.headSha;
  if (!same) return false;
  if (was.status === 'queued') return false;
  if (was.status === 'waiting' && was.held === 'cap') return false;
  if (was.status === 'running') return active || !isStaleRunning(was, now);
  return true;
}

const metaOf = (repo: string, host: GitHost, pr: OpenPr): ReviewMeta => ({
  repo,
  number: pr.number,
  title: pr.title,
  url: pr.url,
  author: pr.author,
  branch: pr.branch,
  base: pr.base,
  headSha: pr.headSha,
  ...(host.id === 'github' ? {} : { host: host.id }),
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `how`: whether the AI step read the PR in a checkout or the diff alone (none when it wasn't asked). */
type Prepared = HostResult<{ review: PrReviewWire; how?: string }> | { ok: false; error: string; held: true };

export function createReviewQueue(deps: ReviewQueueDeps): ReviewQueue {
  const now = () => deps.now?.() ?? new Date();
  let sweeping: Promise<void> | null = null;
  /** The temporary checkouts a stopped run left are swept at the first sweep. */
  let treesSwept = false;
  /** The reviews this queue is preparing now (a `running` row not among them was left by a run that stopped). */
  const active = new Set<string>();
  /** One review at a time, the user's clicks included. */
  let chain: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f, f);
    chain = p.catch(() => undefined);
    return p;
  };
  const key = (repo: string, n: number) => `${repo}#${n}`;

  const setStatus = (meta: ReviewMeta, status: ReviewStatus, why: string | null, opts: Parameters<typeof withStatus>[5] = {}) =>
    deps.store.upsert(meta.repo, meta.number, (was) => withStatus(was, meta, status, why, now(), opts));

  /**
   * The AI step: read-only in a temporary checkout of the PR when the agent can (`agentInCheckout`), else — or when
   * that run gave no answer — the diff alone (`agent`). `answer` undefined: not asked (no agent, no Logic files).
   * `how`: which it was, for the Activity note.
   */
  async function aiStep(
    project: ReviewProject,
    at: ReviewMeta,
    prepared: PreparedPr,
    rules: KindRule[] | undefined,
  ): Promise<{ answer: string | null | undefined; how?: string }> {
    if (!deps.agent) return { answer: undefined };
    const kinds = kindsOf(prepared.files, prepared.extras, rules);
    const prompt = reviewPrompt(at, prepared.files, kinds);
    if (!prompt) return { answer: undefined };
    let fellBack = 'the agent has no read-only mode';
    if (deps.agentInCheckout) {
      const inTree = await deps
        .agentInCheckout(
          { repoPath: project.path, alias: project.alias, number: at.number, headSha: at.headSha },
          reviewPrompt(at, prepared.files, kinds, { checkout: true }) ?? prompt,
        )
        .catch((err: Error) => ({ answer: null, why: err.message }));
      if (inTree?.answer) return { answer: inTree.answer, how: 'read in a temporary checkout of the PR' };
      if (inTree) fellBack = `the checkout run gave no answer${inTree.why ? `: ${inTree.why}` : ''}`;
    }
    const answer = await deps.agent(prompt).catch(() => null);
    return { answer, how: `read from the diff alone (${fellBack})` };
  }

  /** Prepare one PR. `auto`: the sweep's (the size limit applies to the fetched diff too); your click ignores it. */
  async function prepareOne(project: ReviewProject, meta: ReviewMeta, size: OpenPr | undefined, auto: boolean): Promise<Prepared> {
    const k = key(meta.repo, meta.number);
    active.add(k);
    try {
      const host = deps.hostOf(project.path);
      setStatus(meta, 'running', null, { size });
      deps.changed();
      const prepared = await deps
        .prepare(project.path, host, { number: meta.number, base: meta.base })
        .catch((err: Error): HostResult<PreparedPr> => ({ ok: false, error: err.message }));
      if (!prepared.ok) {
        setStatus(meta, 'failed', prepared.error);
        deps.changed();
        return { ok: false, error: prepared.error };
      }
      const added = prepared.files.reduce((n, f) => n + f.added, 0);
      const deleted = prepared.files.reduce((n, f) => n + f.deleted, 0);
      const { maxLines } = deps.limits();
      if (auto && added + deleted > maxLines) {
        // A host whose list says nothing of size (Azure DevOps): the limit applies once the diff is fetched.
        const why = `${added + deleted} changed lines: over the size limit (${maxLines}), so it waits for your click`;
        setStatus(meta, 'waiting', why, { held: 'size', diffSize: { files: prepared.files.length, added, deleted } });
        deps.changed();
        return { ok: false, error: why, held: true };
      }
      const rules = deps.rules?.();
      // The fetched head (a push since the list moved it); the listed one stays what the next sweep compares.
      const at = { ...meta, headSha: prepared.headSha || meta.headSha };
      const { answer, how } = await aiStep(project, at, prepared, rules);
      const fresh: PrReviewWire = {
        ...buildReview(at, prepared.files, prepared.extras, answer, {
          rules,
          now: now(),
          notAskedWhy: deps.agent ? undefined : 'no agent for the AI step: stories are by folder',
        }),
        listedHead: meta.headSha,
        mergeBase: prepared.mergeBase,
        preparedAt: now().toISOString(),
      };
      // Read and written in one transaction: a draft you add meanwhile is carried over, never overwritten.
      const review = deps.store.upsert(meta.repo, meta.number, (was) => carryForward(was, fresh));
      deps.changed();
      return { ok: true, review, ...(how ? { how } : {}) };
    } catch (err) {
      // Whatever threw, the row doesn't stay `running` (its button would stay disabled for good).
      const error = `couldn't prepare it: ${(err as Error).message}`;
      setStatus(meta, 'failed', error);
      deps.changed();
      return { ok: false, error };
    } finally {
      active.delete(k);
    }
  }

  async function sweepNow(): Promise<void> {
    const run = deps.activity?.start('reviews', 'Preparing PR reviews');
    const note = (text: string, level: 'info' | 'action' | 'warn' = 'info') => run?.note(text, { level });
    const { maxPerDay, maxLines } = deps.limits();
    const asked: string[] = [];
    const open = new Set<string>();
    const paths = new Map<string, string>();
    const todo: Array<{ project: ReviewProject; meta: ReviewMeta; pr: OpenPr }> = [];
    try {
      if (!treesSwept && deps.sweepTrees) {
        treesSwept = true;
        // In the one-at-a-time chain: never while a click's review reads its checkout.
        const left = await oneAtATime(deps.sweepTrees).catch((err: Error) => {
          note(`couldn't sweep the temporary checkouts: ${err.message}`, 'warn');
          return { swept: [], failed: [] };
        });
        if (left.swept.length)
          note(`removed ${plural(left.swept.length, 'temporary PR checkout')} a stopped run left: ${left.swept.join(', ')}`, 'action');
        if (left.failed.length)
          note(`couldn't remove ${plural(left.failed.length, 'temporary PR checkout')}: ${left.failed.join(', ')}`, 'warn');
      }
      for (const project of deps.projects()) {
        if (project.mode === 'off') continue;
        paths.set(project.alias, project.path);
        const host = deps.hostOf(project.path);
        const list = await host.openPrs(deps.run, project.path).catch((err: Error) => ({ ok: false as const, error: err.message }));
        if (!list.ok) {
          note(`${project.alias}: couldn't list its open PRs (${list.error}); keeping what it had`, 'warn');
          continue;
        }
        // A list at its limit may have left open PRs out: their reviews aren't dropped as if closed.
        if (list.more) note(`${project.alias}: more open PRs than one listing returns; keeping the reviews of those not listed`, 'warn');
        else asked.push(project.alias);
        for (const pr of list.prs) open.add(key(project.alias, pr.number));
        const viewer = await host.viewer(deps.run, project.path).catch(() => null);
        if (!viewer) {
          // Without who you are, your own PRs would be reviewed — or, asked-only, none: try again next sweep.
          note(`${project.alias}: couldn't tell who you are on ${host.name}; its PRs wait for the next sweep`, 'warn');
          continue;
        }
        const { take, left } = candidates(list.prs, project.mode, viewer);
        if (left.length) note(`${project.alias}: left out ${left.map((l) => `#${l.pr.number} (${l.why})`).join(', ')}`);
        for (const pr of take) {
          const was = deps.store.read(project.alias, pr.number);
          if (upToDate(was, pr, now(), active.has(key(project.alias, pr.number)))) continue;
          const meta = metaOf(project.alias, host, pr);
          const lines = pr.additions + pr.deletions;
          if (lines > maxLines) {
            setStatus(meta, 'waiting', `${lines} changed lines: over the size limit (${maxLines}), so it waits for your click`, {
              size: pr,
              held: 'size',
            });
            note(`${project.alias} #${pr.number}: ${lines} lines, waits for a click`);
            continue;
          }
          if (was?.status === 'running') note(`${project.alias} #${pr.number}: left preparing by a run that stopped; again`, 'warn');
          setStatus(meta, 'queued', null, { size: pr });
          todo.push({ project, meta, pr });
        }
      }
      const gone = deps.store.keepOnly(asked, open);
      if (gone.length) note(`${plural(gone.length, 'review')} of PRs no longer open dropped`);
      for (const g of gone) {
        const at = paths.get(g.repo);
        if (at) await deps.dropRef?.(at, g.number).catch(() => undefined);
      }
      deps.changed();
      for (const t of todo) {
        if (maxPerDay !== null && preparedOn(deps.store.all(), now()) >= maxPerDay) {
          setStatus(t.meta, 'waiting', `today's ${maxPerDay} automatic reviews are done: it waits for tomorrow, or your click`, {
            size: t.pr,
            held: 'cap',
          });
          note(`${t.project.alias} #${t.pr.number}: today's cap of ${maxPerDay} reached; waits`);
          continue;
        }
        const r = await oneAtATime(() => prepareOne(t.project, t.meta, t.pr, true));
        if (r.ok)
          note(
            `${t.project.alias} #${t.pr.number}: prepared — ${plural(r.review.stories.length, 'story', 'stories')}, ${plural(r.review.tests.gaps.length, 'untested change')}${r.review.why ? ` (${r.review.why})` : ''}${r.how ? `; ${r.how}` : ''}`,
            'action',
          );
        else if ('held' in r) note(`${t.project.alias} #${t.pr.number}: ${r.error}`);
        else note(`${t.project.alias} #${t.pr.number}: couldn't prepare it (${r.error})`, 'warn');
      }
      deps.changed();
      run?.done(todo.length ? `${plural(todo.length, 'PR')} looked at` : 'nothing new');
    } catch (err) {
      run?.fail((err as Error).message);
    }
  }

  return {
    sweep() {
      // One sweep at a time: a second asker gets the one running.
      sweeping ??= sweepNow().finally(() => {
        sweeping = null;
      });
      return sweeping;
    },
    async runNow(repo, number) {
      const project = deps.projects().find((p) => p.alias === repo);
      if (!project) return { ok: false, error: `${repo} isn't one of your repos` };
      const host = deps.hostOf(project.path);
      const list = await host.openPrs(deps.run, project.path).catch((err: Error) => ({ ok: false as const, error: err.message }));
      if (!list.ok) return { ok: false, error: list.error };
      const pr = list.prs.find((p) => p.number === number);
      if (!pr) return { ok: false, error: `#${number} isn't an open pull request of ${repo}` };
      const run = deps.activity?.start('reviews', `Preparing the review of ${repo} #${number}`);
      const r = await oneAtATime(() => prepareOne(project, metaOf(repo, host, pr), pr, false));
      if (r.ok) run?.done(`prepared${r.how ? `; ${r.how}` : ''}`);
      else run?.fail(r.error);
      return r.ok ? { ok: true, review: r.review } : { ok: false, error: r.error };
    },
  };
}
