import type { CommandRunner } from '../platform/command-runner.js';
import type { GitHost, HostResult, OpenPr } from '../hosts/types.js';
import type { PrReviewWire, ReviewMode, ReviewStatus } from '../api-types.js';
import type { ActivityLog } from '../platform/activity.js';
import type { KindRule } from './change-kinds.js';
import type { PreparedPr } from './review-source.js';
import { buildReview, kindsOf, reviewPrompt, type ReviewMeta } from './review-build.js';
import { reviewKey } from './review-store.js';

/**
 * The review queue (#64): which open PRs get a review prepared, and when.
 * Policy with its I/O passed in (work web wires git, the host, the agent,
 * state.db).
 *
 * - Per project (a repo or a group, config `reviews.projects`): `all` open
 *   PRs (the default), only those `asked` of you by name, or `off`. Never
 *   your own PRs, never drafts: a review is for what others ask you to read.
 * - A review is for one head commit: a new push queues it again; the same
 *   head is never done twice.
 * - Automatic reviews spend the user's agent plan: one at a time, at most
 *   `maxPerDay` a day, and a PR over `maxLines` changed lines waits for a
 *   click (`runNow` ignores both: the user asked).
 * - Reviews of PRs no longer open go.
 * Each decision is noted in the Activity panel with its reason.
 */

export interface ReviewProject {
  alias: string;
  path: string;
  mode: ReviewMode;
}

export interface ReviewStore {
  read(repo: string, number: number): PrReviewWire | null;
  write(r: PrReviewWire): void;
  all(): PrReviewWire[];
  keepOnly(repos: string[], open: Set<string>): number;
}

export interface ReviewQueueDeps {
  projects: () => ReviewProject[];
  hostOf: (repoPath: string) => GitHost;
  run: CommandRunner;
  prepare: (repoPath: string, host: GitHost, pr: { number: number; base: string }) => Promise<HostResult<PreparedPr>>;
  /** The summarising agent's one-shot run (`runInternal`); absent: no AI step, stories by folder. */
  agent?: (prompt: string) => Promise<string | null>;
  rules?: () => KindRule[];
  store: ReviewStore;
  limits: () => { maxPerDay: number; maxLines: number };
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

/** A local day (YYYY-MM-DD). */
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A review not prepared yet: what is known of the PR, and where it stands. Pure. */
export function placeholder(meta: ReviewMeta, status: ReviewStatus, why: string | null, now: Date, size?: OpenPr): PrReviewWire {
  return {
    ...meta,
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

export function createReviewQueue(deps: ReviewQueueDeps): ReviewQueue {
  const now = () => deps.now?.() ?? new Date();
  let sweeping: Promise<void> | null = null;
  /** One review at a time, the user's clicks included. */
  let chain: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f, f);
    chain = p.catch(() => undefined);
    return p;
  };

  const preparedToday = () => {
    const today = dayOf(now());
    return deps.store.all().filter((r) => r.preparedAt && dayOf(new Date(r.preparedAt)) === today).length;
  };

  async function prepareOne(
    project: ReviewProject,
    meta: ReviewMeta,
    size: OpenPr | undefined,
  ): Promise<HostResult<{ review: PrReviewWire }>> {
    const host = deps.hostOf(project.path);
    deps.store.write(placeholder(meta, 'running', null, now(), size));
    deps.changed();
    const prepared = await deps
      .prepare(project.path, host, { number: meta.number, base: meta.base })
      .catch((err: Error): HostResult<PreparedPr> => ({ ok: false, error: err.message }));
    if (!prepared.ok) {
      deps.store.write(placeholder(meta, 'failed', prepared.error, now(), size));
      deps.changed();
      return { ok: false, error: prepared.error };
    }
    const rules = deps.rules?.();
    const at = { ...meta, headSha: prepared.headSha || meta.headSha };
    const prompt = deps.agent ? reviewPrompt(at, prepared.files, kindsOf(prepared.files, prepared.extras, rules)) : null;
    const answer = prompt && deps.agent ? await deps.agent(prompt).catch(() => null) : undefined;
    const review: PrReviewWire = {
      ...buildReview(at, prepared.files, prepared.extras, answer, {
        rules,
        now: now(),
        notAskedWhy: deps.agent ? undefined : 'no agent for the AI step: stories are by folder',
      }),
      mergeBase: prepared.mergeBase,
      preparedAt: now().toISOString(),
    };
    deps.store.write(review);
    deps.changed();
    return { ok: true, review };
  }

  async function sweepNow(): Promise<void> {
    const run = deps.activity?.start('reviews', 'Preparing PR reviews');
    const note = (text: string, level: 'info' | 'action' | 'warn' = 'info') => run?.note(text, { level });
    const { maxPerDay, maxLines } = deps.limits();
    const asked: string[] = [];
    const open = new Set<string>();
    const todo: Array<{ project: ReviewProject; meta: ReviewMeta; pr: OpenPr }> = [];
    try {
      for (const project of deps.projects()) {
        if (project.mode === 'off') continue;
        const host = deps.hostOf(project.path);
        const list = await host.openPrs(deps.run, project.path).catch((err: Error) => ({ ok: false as const, error: err.message }));
        if (!list.ok) {
          note(`${project.alias}: couldn't list its open PRs (${list.error}); keeping what it had`, 'warn');
          continue;
        }
        asked.push(project.alias);
        for (const pr of list.prs) open.add(reviewKey(project.alias, pr.number));
        const viewer = await host.viewer(deps.run, project.path).catch(() => null);
        const { take } = candidates(list.prs, project.mode, viewer);
        for (const pr of take) {
          const was = deps.store.read(project.alias, pr.number);
          // The same head, prepared (or waiting, or failed): nothing new to read. A queued one is picked up below.
          if (was && was.headSha === pr.headSha && was.status !== 'queued') continue;
          const meta = metaOf(project.alias, host, pr);
          const lines = pr.additions + pr.deletions;
          if (lines > maxLines) {
            deps.store.write(
              placeholder(
                meta,
                'waiting',
                `${lines} changed lines: over the size limit (${maxLines}), so it waits for your click`,
                now(),
                pr,
              ),
            );
            note(`${project.alias} #${pr.number}: ${lines} lines, waits for a click`);
            continue;
          }
          deps.store.write(placeholder(meta, 'queued', null, now(), pr));
          todo.push({ project, meta, pr });
        }
      }
      const gone = deps.store.keepOnly(asked, open);
      if (gone) note(`${gone} review${gone === 1 ? '' : 's'} of PRs no longer open dropped`);
      deps.changed();
      for (const t of todo) {
        if (preparedToday() >= maxPerDay) {
          deps.store.write(
            placeholder(
              t.meta,
              'waiting',
              `today's ${maxPerDay} automatic reviews are done: it waits for tomorrow, or your click`,
              now(),
              t.pr,
            ),
          );
          note(`${t.project.alias} #${t.pr.number}: today's cap of ${maxPerDay} reached; waits`);
          continue;
        }
        const r = await oneAtATime(() => prepareOne(t.project, t.meta, t.pr));
        if (r.ok)
          note(
            `${t.project.alias} #${t.pr.number}: prepared — ${r.review.stories.length} stor${r.review.stories.length === 1 ? 'y' : 'ies'}, ${r.review.tests.gaps.length} untested change${r.review.tests.gaps.length === 1 ? '' : 's'}${r.review.why ? ` (${r.review.why})` : ''}`,
            'action',
          );
        else note(`${t.project.alias} #${t.pr.number}: couldn't prepare it (${r.error})`, 'warn');
      }
      deps.changed();
      run?.done(todo.length ? `${todo.length} PR${todo.length === 1 ? '' : 's'} looked at` : 'nothing new');
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
      return oneAtATime(() => prepareOne(project, metaOf(repo, host, pr), pr));
    },
  };
}
