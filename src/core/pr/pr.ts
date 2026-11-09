import { DEFAULT_HOST, hostForRepo, type HostLookupDeps } from '../hosts/index.js';
import { defaultRunner, type CommandRunner } from './ship.js';

export type { BranchPrMap, PullRequestInfo } from './pr-types.js';
import type { BranchPrMap, PullRequestInfo } from './pr-types.js';

/**
 * The PRs for the dashboard, each repo asked of the host its origin is on
 * (`hostForRepo`): a group can mix hosts. Returns a map from branch name →
 * PRs across repos, and the repos whose list may be missing PRs. A host
 * whose list throws leaves every repo of its own incomplete.
 */
export async function fetchAllPullRequests(
  repos: Record<string, string>,
  hosts: { run?: CommandRunner; lookup?: HostLookupDeps } = {},
): Promise<{ map: BranchPrMap; incomplete: string[] }> {
  const prs: PullRequestInfo[] = [];
  const incomplete: string[] = [];
  const byHost = new Map<
    string,
    { host: ReturnType<typeof hostForRepo>['host']; repos: Array<{ alias: string; path: string; origin: string | null }> }
  >();
  for (const [alias, repoPath] of Object.entries(repos)) {
    const { host, origin } = hostForRepo(repoPath, hosts.lookup);
    const entry = byHost.get(host.id) ?? { host, repos: [] };
    entry.repos.push({ alias, path: repoPath, origin });
    byHost.set(host.id, entry);
  }
  const lists = await Promise.all(
    [...byHost.values()].map(async ({ host, repos: hostRepos }) => {
      try {
        const r = await host.list(hostRepos, hosts.run ?? defaultRunner);
        // Absent for GitHub (the wire's default), so a reader from before hosts sees what it always did.
        return { prs: host.id === DEFAULT_HOST ? r.prs : r.prs.map((p) => ({ ...p, host: host.id })), incomplete: r.incomplete };
      } catch {
        return { prs: [], incomplete: hostRepos.map((r) => r.alias) };
      }
    }),
  );
  for (const l of lists) {
    prs.push(...l.prs);
    incomplete.push(...l.incomplete);
  }
  const map: BranchPrMap = new Map();
  for (const pr of prs) {
    const existing = map.get(pr.branch);
    if (existing) existing.push(pr);
    else map.set(pr.branch, [pr]);
  }
  return { map, incomplete };
}
