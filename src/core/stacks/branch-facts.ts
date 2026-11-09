import { defaultRunner, type CommandRunner } from '../platform/command-runner.js';
import { bestEffort, logSwallowed } from '../platform/best-effort.js';
import type { SessionBranchWire, SessionCi, ShipPr } from '../api-types.js';
import { stageOfPr } from '../pr/pr-stage.js';
import {
  backfillSessionBranches,
  branchHidden,
  MAX_WATCHED_BRANCHES,
  noteBranchFacts,
  readSessionBranches,
  repoNameOf,
  type SessionBranches,
} from '../sessions/session-branches.js';
import { checkedOutBranch } from '../git/git-head.js';
import { sessionIdFor } from '../sessions/session-id.js';
import type { WorktreeSession } from '../sessions/session-types.js';

/**
 * What a session's other branches hold (session-branches.ts records them):
 * still there, pushed, how many commits its base lacks, how many origin
 * lacks, merged. Git through a CommandRunner (argv only), a few runs per
 * branch — so read in the background (BranchFactsCache, beside behind-main's)
 * and by the PR watch's preflight, never on a request's path.
 */

export interface BranchFacts {
  exists: boolean;
  /** Its tip, when it exists. */
  sha: string | null;
  /** `origin/<name>` exists. */
  pushed: boolean;
  /** Commits on it that its base (origin/HEAD) doesn't have; null: unknown. */
  commits: number | null;
  /** Commits on it that origin doesn't have (all of `commits` when never pushed); null: unknown. */
  unpushed: number | null;
  /** Its commits are all in its base, and it was pushed (a branch merged the usual way). */
  merged: boolean;
}

/** The repo's main line (`origin/main`), as origin/HEAD names it; null when it doesn't. */
export async function repoBase(repo: string, run: CommandRunner = defaultRunner): Promise<string | null> {
  const head = await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], repo);
  const base = head.code === 0 ? head.stdout.trim() : '';
  return base && base !== 'origin/HEAD' ? base : null;
}

const count = (out: { code: number; stdout: string }) =>
  out.code === 0 && /^\d+$/.test(out.stdout.trim()) ? Number(out.stdout.trim()) : null;

/** One branch of one repo. `base`: the repo's main line (repoBase), passed so a repo's branches ask it once. */
export async function branchFacts(
  repo: string,
  name: string,
  run: CommandRunner = defaultRunner,
  base?: string | null,
): Promise<BranchFacts> {
  const git = (...args: string[]) => run('git', ['-C', repo, ...args], repo);
  const local = `refs/heads/${name}`;
  const remote = `refs/remotes/origin/${name}`;
  const tip = await git('rev-parse', '--verify', '--quiet', local);
  const exists = tip.code === 0;
  const pushed = (await git('rev-parse', '--verify', '--quiet', remote)).code === 0;
  if (!exists) return { exists, sha: null, pushed, commits: null, unpushed: null, merged: false };
  const main = base === undefined ? await repoBase(repo, run) : base;
  const commits = main ? count(await git('rev-list', '--count', `${main}..${local}`)) : null;
  const unpushed = pushed ? count(await git('rev-list', '--count', `${remote}..${local}`)) : commits;
  return { exists, sha: tip.stdout.trim() || null, pushed, commits, unpushed, merged: pushed && commits === 0 };
}

/** A repo's other branches to look at: by name, in its checkout. */
export interface BranchJob {
  repo: string;
  path: string;
  name: string;
}

export const factsKey = (repo: string, name: string) => `${repo}\u0000${name}`;

/**
 * Per session, refreshed in the background a couple of sessions at a time;
 * reads never wait (BehindCache's way). `onFacts`: what a look found, to keep
 * (a branch seen deleted, or merged: session-branches.ts `noteBranchFacts`).
 */
export class BranchFactsCache {
  private readonly entries = new Map<string, { value: Map<string, BranchFacts>; at: number; inFlight: boolean; key: string }>();
  private running = 0;
  private readonly queue: Array<{ id: string; jobs: BranchJob[] }> = [];

  constructor(
    private readonly opts: {
      ttlMs?: number;
      concurrency?: number;
      run?: CommandRunner;
      onChange?: () => void;
      onFacts?: (id: string, facts: Array<BranchJob & BranchFacts>) => void;
      now?: () => number;
    } = {},
  ) {}

  /** What the last look found (an empty map before the first); schedules one when stale or the branches changed. */
  get(id: string, jobs: BranchJob[]): Map<string, BranchFacts> {
    const now = (this.opts.now ?? Date.now)();
    const key = jobs.map((j) => factsKey(j.repo, j.name)).join('|');
    const e = this.entries.get(id);
    const moved = !!e && e.key !== key;
    if (!e || moved || (!e.inFlight && now - e.at > (this.opts.ttlMs ?? 5 * 60_000))) this.schedule(id, jobs, key);
    return this.entries.get(id)?.value ?? new Map();
  }

  /** Look again soon (a turn ended, a push). */
  invalidate(id: string): void {
    const e = this.entries.get(id);
    if (e) e.at = 0;
  }

  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private schedule(id: string, jobs: BranchJob[], key: string): void {
    const e = this.entries.get(id) ?? { value: new Map<string, BranchFacts>(), at: 0, inFlight: false, key };
    if (e.inFlight && e.key === key) return;
    e.inFlight = true;
    e.key = key;
    this.entries.set(id, e);
    this.queue.push({ id, jobs });
    this.pump();
  }

  private pump(): void {
    while (this.running < (this.opts.concurrency ?? 2) && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      void lookAt(job.jobs, this.opts.run)
        .catch((err) => {
          logSwallowed(`branch facts for ${job.id}`, err);
          return null;
        })
        .then((found) => {
          const e = this.entries.get(job.id)!;
          e.inFlight = false;
          e.at = (this.opts.now ?? Date.now)();
          if (!found) return;
          const value = new Map(found.map((f) => [factsKey(f.repo, f.name), strip(f)]));
          const changed = JSON.stringify([...e.value]) !== JSON.stringify([...value]);
          e.value = value;
          this.opts.onFacts?.(job.id, found);
          if (changed) this.opts.onChange?.();
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

const strip = (f: BranchJob & BranchFacts): BranchFacts => ({
  exists: f.exists,
  sha: f.sha,
  pushed: f.pushed,
  commits: f.commits,
  unpushed: f.unpushed,
  merged: f.merged,
});

async function lookAt(jobs: BranchJob[], run?: CommandRunner): Promise<Array<BranchJob & BranchFacts>> {
  const bases = new Map<string, string | null>();
  const out: Array<BranchJob & BranchFacts> = [];
  for (const j of jobs) {
    if (!bases.has(j.path)) bases.set(j.path, await repoBase(j.path, run));
    out.push({ ...j, ...(await branchFacts(j.path, j.name, run, bases.get(j.path))) });
  }
  return out;
}

/** The PR of a repo's branch, from the PR watch's last check: the checked-out one's, or another's. */
export function prOfBranch(ci: SessionCi | null | undefined, repo: string, name: string): ShipPr | null {
  const r = ci?.repos.find((x) => x.name === repo);
  if (!r) return null;
  if (r.branch === name && r.pr) return r.pr;
  return r.otherPrs?.find((o) => o.branch === name)?.pr ?? null;
}

/**
 * The branches a session's row shows: every recorded one not hidden (merged
 * and deleted a while ago), each with its facts and PR, the checked-out ones
 * first, the rest newest first. Null unless some repo has been on more than
 * one: a session that stayed on its branch shows nothing new. Pure.
 */
export function branchesWire(
  rec: SessionBranches | null | undefined,
  current: (repo: string) => string | null,
  facts: Map<string, BranchFacts>,
  ci: SessionCi | null | undefined,
  now: number,
): SessionBranchWire[] | null {
  if (!rec?.branches.length) return null;
  const rows: SessionBranchWire[] = [];
  for (const b of rec.branches) {
    const pr = prOfBranch(ci, b.repo, b.name);
    if (branchHidden(b, now, pr?.state === 'MERGED')) continue;
    const f = facts.get(factsKey(b.repo, b.name));
    rows.push({
      repo: b.repo,
      name: b.name,
      current: current(b.repo) === b.name,
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen,
      ...(b.from ? { from: b.from } : {}),
      ...(f
        ? {
            exists: f.exists,
            pushed: f.pushed,
            commits: f.commits,
            unpushed: f.unpushed,
            merged: f.merged || !!b.merged || pr?.state === 'MERGED',
          }
        : b.merged || pr?.state === 'MERGED'
          ? { merged: true }
          : {}),
      ...(pr ? { pr: { number: pr.number, url: pr.url, state: pr.state, kind: stageOfPr(pr) } } : {}),
    });
  }
  const repos = new Set(rows.map((r) => r.repo));
  if (![...repos].some((repo) => rows.filter((r) => r.repo === repo).length > 1)) return null;
  return rows.sort(
    (a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || a.repo.localeCompare(b.repo),
  );
}

/**
 * The sessions list's branches (work web): each row's recorded branches with
 * their facts — read in the background (BranchFactsCache), what it finds kept
 * (deleted, merged, pushed once) — and, once per session recorded before the
 * list began, its reflog read into the record (backfillSessionBranches), one
 * session at a time, off the request's path. `wire` never runs git.
 */
export function createSessionBranches(
  opts: {
    onChange?: () => void;
    run?: CommandRunner;
    now?: () => number;
    /** Tests: the reflog read and the fact keeping (default: session-branches.ts). */
    backfill?: (s: WorktreeSession) => SessionBranches | void;
    keepFacts?: (id: string, facts: Array<BranchJob & BranchFacts>) => void;
  } = {},
) {
  const now = opts.now ?? Date.now;
  const facts = new BranchFactsCache({
    ...(opts.run ? { run: opts.run } : {}),
    now,
    onChange: opts.onChange,
    onFacts: (id, found) =>
      bestEffort(`keep the branch facts of ${id}`, () => (opts.keepFacts ?? ((sid, f) => noteBranchFacts(sid, f)))(id, found)),
  });
  const backfill = opts.backfill ?? ((s: WorktreeSession) => backfillSessionBranches(s));
  const asked = new Set<string>();
  const waiting: WorktreeSession[] = [];
  let busy = false;
  const pump = () => {
    if (busy) return;
    const s = waiting.shift();
    if (!s) return;
    busy = true;
    setImmediate(() => {
      const rec = bestEffort(`read the branches of ${s.target}:${s.branch} from its reflog`, () => backfill(s));
      busy = false;
      // Only a session that turns out to have worked on more than one branch looks any different.
      if (rec && branchJobs(s, rec, now())) opts.onChange?.();
      pump();
    });
  };
  return {
    /** The row's branches (branchesWire), from what was recorded and last looked at. */
    wire(s: WorktreeSession, rec: SessionBranches | null | undefined, ci: SessionCi | null | undefined): SessionBranchWire[] | null {
      if (s.archivedAt) return null;
      const id = sessionIdFor(s);
      if (!rec?.backfilled && !asked.has(id)) {
        asked.add(id);
        waiting.push(s);
        pump();
      }
      const plan = branchJobs(s, rec, now());
      return plan ? branchesWire(rec, plan.current, facts.get(id, plan.jobs), ci, now()) : null;
    },
    invalidate: (id: string) => facts.invalidate(id),
    async idle(): Promise<void> {
      await facts.idle();
      while (busy || waiting.length) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

/**
 * What to look at for a session's row: each repo's visible recorded branches (the checked-out one first, then
 * the most recent, at most MAX_WATCHED_BRANCHES others), and what each repo has checked out (HEAD files). Null
 * when no repo has been on more than one branch. No git.
 */
export function branchJobs(
  s: Pick<WorktreeSession, 'target' | 'isGroup' | 'paths'>,
  rec: SessionBranches | null | undefined,
  now: number,
): { jobs: BranchJob[]; current: (repo: string) => string | null } | null {
  if (!rec?.branches.length) return null;
  const currentOf = new Map(s.paths.map((p) => [repoNameOf(s, p), checkedOutBranch(p)]));
  const visible = rec.branches.filter((b) => !branchHidden(b, now));
  const repos = new Set(visible.map((b) => b.repo));
  if (![...repos].some((r) => visible.filter((b) => b.repo === r).length > 1)) return null;
  const pathOf = new Map(s.paths.map((p) => [repoNameOf(s, p), p]));
  const jobs: BranchJob[] = [];
  for (const repo of repos) {
    const p = pathOf.get(repo);
    if (!p) continue;
    const isCurrent = (name: string) => Number(name === currentOf.get(repo));
    const mine = visible
      .filter((b) => b.repo === repo)
      .sort((a, b) => isCurrent(b.name) - isCurrent(a.name) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      .slice(0, MAX_WATCHED_BRANCHES + 1);
    for (const b of mine) jobs.push({ repo, path: p, name: b.name });
  }
  return { jobs, current: (repo) => currentOf.get(repo) ?? null };
}

/**
 * The same now, for the CLI (`work sessions --json`, `work status`): the record (read from the reflog first
 * when it never was), each branch looked at with git, the PR from the PR watch's last check. Null when it stayed
 * on one branch.
 */
export async function sessionBranchesNow(
  s: WorktreeSession,
  ci: SessionCi | null | undefined,
  run: CommandRunner = defaultRunner,
  now = Date.now(),
): Promise<SessionBranchWire[] | null> {
  if (s.archivedAt) return null;
  let rec = readSessionBranches(sessionIdFor(s));
  if (!rec?.backfilled) rec = bestEffort(`read the branches of ${s.target}:${s.branch}`, () => backfillSessionBranches(s), rec) ?? rec;
  const plan = branchJobs(s, rec, now);
  if (!plan) return null;
  const found = await lookAt(plan.jobs, run);
  return branchesWire(rec, plan.current, new Map(found.map((f) => [factsKey(f.repo, f.name), strip(f)])), ci, now);
}
