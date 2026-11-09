import os from 'node:os';
import type { CommandRunner } from '../platform/command-runner.js';
import { DEFAULT_HOST, defaultHost, hostById, hostForRepo, hostOfPrUrl, originHostname } from '../hosts/index.js';
import type { GitHost } from '../hosts/types.js';
import type { ReviewFeedback } from './review-types.js';
import type { PrWatchDeps } from './pr-watch.js';
import { shipPreflight, type AskGh, type PreflightOptions } from './ship.js';
import type { SessionCi, ShipPr, ShipPreflight } from '../api-types.js';
import type { PrLookup } from '../hosts/types.js';
import { notePrLooks, noteSessionPrs, readSessionPrs, type PrSighting, type SessionPrs } from './session-prs.js';
import {
  BRANCH_WATCH_MS,
  noteBranchFacts,
  otherBranchesToWatch,
  readSessionBranches,
  wasPushed,
  type SessionBranches,
} from '../sessions/session-branches.js';
import { prsOfCheck } from './pr-watch.js';
import { withRequiredChecks } from './required-checks.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { bestEffort } from '../platform/best-effort.js';
import type { WorktreeSession } from '../sessions/session-types.js';

/**
 * What the PR watch asks a git host, each repo of its own (pr-watch.ts is pure
 * policy and imports no host: the demo uses its notes). `prWatchHostDeps` is
 * what work web wires (ci-routes.ts), so the tests that drive the watch over
 * two hosts drive the wiring itself.
 */

/** A host by its id on the wire (absent or unknown: the default host's, as an older row's is everywhere else). */
const hostOf = (id: string | null | undefined): GitHost => hostById(id) ?? defaultHost();

/** The hostname of a repo's origin (lower case); null with none. */
function repoServer(repoPath: string): string | null {
  const { origin } = hostForRepo(repoPath);
  return origin ? originHostname(origin) : null;
}

/**
 * Who you're signed in as on each host, asked once per host and server: the
 * PR watch tells your PRs from someone else's by it (its `viewer`, given a
 * host's id and the repo). Each host is asked through its own adapter, in the
 * repo's folder: GitHub's login is no one's name on Azure DevOps, and a GitHub
 * Enterprise origin's login isn't github.com's (GitHub's adapter asks that
 * server). A failed ask answers null and is asked again next time.
 */
export function viewerLogin(
  run: CommandRunner,
  lookup: (id: string | undefined) => Pick<GitHost, 'id' | 'viewer'> = hostOf,
  serverOf: (repoPath: string) => string | null = repoServer,
): (host?: string, repoPath?: string) => Promise<string | null> {
  const known = new Map<string, string>();
  return async (hostId, repoPath) => {
    const host = lookup(hostId);
    const key = `${host.id}\n${repoPath ? (serverOf(repoPath) ?? '') : ''}`;
    const was = known.get(key);
    if (was) return was;
    const login = await host.viewer(run, repoPath ?? process.cwd()).catch(() => null);
    if (login) known.set(key, login);
    return login || null;
  };
}

/** A PR's review feedback, asked of the host the repo is on. */
export async function fetchReviewFeedback(repoPath: string, prNumber: number, run: CommandRunner): Promise<ReviewFeedback | null> {
  return hostForRepo(repoPath).host.reviewFeedback(run, repoPath, prNumber);
}

/** The host refused for its API limit, in its own words (the whole of what it said). */
export function hostRateLimited(hostId: string | undefined, text: string): boolean {
  return hostOf(hostId).rateLimited(text);
}

/** The PR watch's host-facing deps, each repo asked of its own host: what work web wires. */
export function prWatchHostDeps(run: CommandRunner): Required<Pick<PrWatchDeps, 'viewer' | 'reviewFeedback' | 'rateLimited'>> {
  return {
    viewer: viewerLogin(run),
    reviewFeedback: (repoPath, n) => fetchReviewFeedback(repoPath, n, run),
    rateLimited: hostRateLimited,
  };
}

/**
 * Which of a session's repos the PR watch's preflight asks their host about: none on a host resting after its API
 * limit (`resting`), and of the rest only a pushed branch, or one whose PR the watch already knows (a merged PR
 * whose branch is gone) — a never-pushed branch can't have a PR.
 */
export function watchAskGh(resting: ((host: string | undefined) => boolean) | undefined, knowsPr: (repoName: string) => boolean): AskGh {
  return (r) => !resting?.(r.host) && (r.hasUpstream || knowsPr(r.name));
}

/**
 * The other branches the PR watch looks at per repo (session-branches.ts: recent ones, at most a few), and which
 * of them it asks their host about: none on a host resting, of the rest a branch pushed now or once (origin's copy
 * deleted after its PR merged), or one whose PR it already knows.
 */
export function watchBranchOptions(
  rec: SessionBranches | null,
  now: number,
  resting: ((host: string | undefined) => boolean) | undefined,
  knowsPr: (repoName: string, branch: string) => boolean,
): Required<Pick<PreflightOptions, 'branches' | 'askBranch'>> {
  return {
    branches: (repo, current) => otherBranchesToWatch(rec, repo.name, current, now, BRANCH_WATCH_MS),
    askBranch: (repo, b) => !resting?.(repo.host) && (b.pushed || wasPushed(rec, repo.name, b.name) || knowsPr(repo.name, b.name)),
  };
}

/** What `withListedPrs` needs of the world: the hosts, and what the watch knew last. */
export interface ListedPrsIo {
  /** The host's name for the repo at this folder (`owner/name`), lower case; null when it can't be told. */
  repoIdOf(repoPath: string): string | null;
  /** The host a PR link is on (its id; absent: the default); null when no host claims it. */
  hostOfUrl(url: string): string | undefined | null;
  /** Look the PR up on its host: in its repo's folder when the session has it. */
  lookup(cwd: string | undefined, host: string | undefined, ref: { number: number; url: string }): Promise<PrLookup>;
  /** That host rests after its API limit: ask it nothing. */
  resting?: (host: string | undefined) => boolean;
  /** What the watch's last check had of this PR (kept while the host can't be asked). */
  previous?: (url: string) => ShipPr | undefined;
}

/**
 * The preflight with the session's listed PRs (session-prs.ts) that its branches didn't find: each looked up by its
 * link — a PR merged or closed is its last look, asked no more —, put on its repo (`listedPrs`), or in `elsewhere`
 * when the session doesn't have the repo. A host that can't be asked keeps the watch's last look; with none, the PR
 * is `unknownPrs` (never read as gone: the session isn't archived meanwhile). Also returns what to keep on the list:
 * every PR the branches found (`sightings`), and the looks (a merged or closed one's `final`).
 */
export async function withListedPrs(
  pre: ShipPreflight,
  listed: SessionPrs | null,
  io: ListedPrsIo,
): Promise<{ pre: ShipPreflight; sightings: PrSighting[]; looks: Array<{ url: string; pr: ShipPr; branch?: string }> }> {
  const sightings: PrSighting[] = [];
  for (const r of pre.repos) {
    const on = r.branch && r.branch !== 'HEAD' ? r.branch : undefined;
    if (r.pr) sightings.push({ url: r.pr.url, number: r.pr.number, ...(on ? { branch: on } : {}), source: 'branch' });
    for (const b of r.otherBranches ?? [])
      if (b.pr) sightings.push({ url: b.pr.url, number: b.pr.number, branch: b.name, source: 'branch' });
  }
  const looks: Array<{ url: string; pr: ShipPr; branch?: string }> = [];
  const known = new Set(sightings.map((s) => s.url.toLowerCase()));
  const todo = (listed?.prs ?? []).filter((p) => !known.has(p.url.toLowerCase()));
  if (!todo.length) return { pre, sightings, looks };

  const repos = pre.repos.map((r) => ({ ...r, listedPrs: [...(r.listedPrs ?? [])] }));
  const ids = new Map(repos.map((r) => [r.name, io.repoIdOf(r.path)]));
  const elsewhere = [...(pre.elsewhere ?? [])];
  const unknownPrs = [...(pre.unknownPrs ?? [])];
  for (const rec of todo) {
    const target = rec.repoId ? repos.find((r) => ids.get(r.name) === rec.repoId.toLowerCase()) : undefined;
    const host = target ? target.host : (io.hostOfUrl(rec.url) ?? undefined);
    let pr: ShipPr | undefined = rec.final;
    if (!pr) {
      if (io.resting?.(host)) pr = io.previous?.(rec.url);
      else {
        const found = await io
          .lookup(target?.path, host, { number: rec.number, url: rec.url })
          .catch((err: Error): PrLookup => ({ kind: 'error', error: err.message }));
        if (found.kind === 'pr') {
          pr = found.pr;
          looks.push({ url: rec.url, pr, ...(pr.headBranch ? { branch: pr.headBranch } : {}) });
        } else if (found.kind === 'error') {
          pr = io.previous?.(rec.url);
          if (!pr) unknownPrs.push(`${target?.name ?? rec.repoId ?? '?'}#${rec.number}: ${found.error}`);
        }
        // 'none': the host has no such PR (deleted): nothing to show.
      }
    }
    if (!pr) continue;
    const branch = pr.headBranch ?? rec.branch;
    if (target) target.listedPrs.push({ branch: branch ?? '', pr });
    else elsewhere.push({ repo: rec.repoId || rec.url, ...(host ? { host } : {}), ...(branch ? { branch } : {}), pr });
  }
  return {
    pre: {
      ...pre,
      repos: repos.map(({ listedPrs, ...r }) => (listedPrs.length ? { ...r, listedPrs } : r)),
      ...(elsewhere.length ? { elsewhere } : {}),
      ...(unknownPrs.length ? { unknownPrs } : {}),
    },
    sightings,
    looks,
  };
}

/** What a preflight found of the other branches, to keep in the record (deleted, merged, pushed once). */
export function branchFactsOf(
  pre: ShipPreflight,
): Array<{ repo: string; name: string; exists: boolean; merged: boolean; pushed: boolean }> {
  return pre.repos.flatMap((r) =>
    (r.otherBranches ?? []).map((b) => ({ repo: r.name, name: b.name, exists: b.exists, merged: b.merged, pushed: b.pushed })),
  );
}

/** The real hosts for `withListedPrs`: each repo's own, a PR outside the session's repos by its link. */
export function listedPrsIo(run: CommandRunner, opts: Pick<ListedPrsIo, 'resting' | 'previous'> = {}): ListedPrsIo {
  return {
    repoIdOf: (repoPath) => {
      const { host, origin } = hostForRepo(repoPath);
      return origin ? (host.repoId(origin)?.toLowerCase() ?? null) : null;
    },
    hostOfUrl: (url) => {
      const h = hostOfPrUrl(url)?.host;
      return h ? (h.id === DEFAULT_HOST ? undefined : h.id) : null;
    },
    lookup: (cwd, host, ref) => hostOf(host).prForRef(run, cwd ?? os.tmpdir(), ref),
    ...opts,
  };
}

/**
 * The PR watch's preflight of a session: Ship's (each repo's checked-out branch and recent other branches), what it
 * found of those branches kept (session-branches.ts), then the session's PR list (session-prs.ts) — the PRs the
 * branches found put on it, the ones they didn't looked up by their link (`withListedPrs`), and what the host said of
 * them kept. What work web wires (ci-routes.ts).
 */
export async function watchPreflight(
  session: WorktreeSession,
  run: CommandRunner,
  opts: {
    resting?: (host: string | undefined) => boolean;
    /** The watch's last check of the session. */
    last?: SessionCi | null;
    now?: number;
    /** `prWatch.requiredChecks` (required-checks.ts). */
    requiredChecks?: Record<string, string[]>;
  } = {},
  io: { preflight?: typeof shipPreflight; listed?: ListedPrsIo } = {},
): Promise<ShipPreflight> {
  const id = sessionIdFor(session);
  const last = opts.last ?? null;
  const repoOf = (name: string) => last?.repos.find((x) => x.name === name);
  const pre = await (io.preflight ?? shipPreflight)(session, run, {
    askGh: watchAskGh(opts.resting, (name) => !!repoOf(name)?.pr),
    ...watchBranchOptions(
      readSessionBranches(id),
      opts.now ?? Date.now(),
      opts.resting,
      (name, branch) => !!repoOf(name)?.otherPrs?.some((p) => p.branch === branch),
    ),
  });
  const facts = branchFactsOf(pre);
  if (facts.length) bestEffort(`keep the branch facts of ${id}`, () => noteBranchFacts(id, facts));
  const previous = (url: string) => (last ? prsOfCheck(last).find((p) => p.pr.url.toLowerCase() === url.toLowerCase())?.pr : undefined);
  const listed = io.listed ?? listedPrsIo(run, { ...(opts.resting ? { resting: opts.resting } : {}), previous });
  const found = await withListedPrs(pre, readSessionPrs(id), listed);
  // The listed ones (and those in other repos) count their checks as the session's repos do (required-checks.ts).
  const ids = new Map(pre.repos.map((r) => [r.name, listed.repoIdOf(r.path)]));
  const out = { ...found, pre: withRequiredChecks(found.pre, opts.requiredChecks, (name) => ids.get(name) ?? null) };
  if (out.sightings.length) bestEffort(`keep the PRs of ${id}`, () => noteSessionPrs(id, out.sightings));
  if (out.looks.length) bestEffort(`keep what the host said of ${id}'s PRs`, () => notePrLooks(id, out.looks));
  return out.pre;
}
