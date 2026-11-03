import type { CommandRunner } from '../platform/command-runner.js';
import { defaultHost, hostById, hostForRepo, originHostname } from '../hosts/index.js';
import type { GitHost } from '../hosts/types.js';
import type { ReviewFeedback } from './review-types.js';
import type { PrWatchDeps } from './pr-watch.js';
import type { AskGh } from './ship.js';

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
