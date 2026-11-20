import type { WorkConfig } from '../platform/config.js';
import { originUrl, readGitConfig } from '../worktree/repo-scan.js';
import { parsePrRef, type PrRef, type PrToStart } from './pr-ref.js';
import { defaultRunner, type CommandRunner } from './ship.js';
import { DEFAULT_HOST, hostForOrigin, hostOfPrUrl } from '../hosts/index.js';

export type PrStartResult = { ok: true; pr: PrToStart } | { ok: false; error: string };

export interface PrStartDeps {
  run?: CommandRunner;
  /** A repo's `.git/config` text (tests pass their own). */
  gitConfig?: (repoPath: string) => string | null;
}

/**
 * Which of your repos a PR is in, and its branch: from its link (the repo
 * matched by its origin) or its number (in `target`, a repo). Refused: a
 * repo you haven't enrolled, a group as the repo of a bare number, a PR
 * that isn't open, and one from a fork — its branch isn't on origin, so the
 * session couldn't push to it (and `work tree` would make a new, empty
 * branch of that name instead).
 */
export async function resolvePrToStart(
  input: string,
  config: Pick<WorkConfig, 'repos' | 'groups'>,
  target?: string,
  deps: PrStartDeps = {},
): Promise<PrStartResult> {
  const run = deps.run ?? defaultRunner;
  const gitConfig = deps.gitConfig ?? readGitConfig;
  // A link any host reads (one registered at run time too), else a number.
  const linked = hostOfPrUrl(input);
  const ref: PrRef | null = linked ? { repo: linked.link.repoId, host: linked.host.id, number: linked.link.number } : parsePrRef(input);
  if (!ref) return { ok: false, error: 'Give a pull request link (as your browser shows it), or its number with a repo.' };

  // Each repo on its own host (its origin's), with its id there.
  const repoOf = (alias: string) => {
    const origin = originUrl(gitConfig(config.repos[alias]) ?? '');
    const host = hostForOrigin(origin);
    return { host, id: origin ? host.repoId(origin) : null };
  };
  let alias: string | undefined;
  if (ref.repo) {
    const matches = Object.keys(config.repos).filter((a) => {
      const r = repoOf(a);
      return r.id === ref.repo && (!ref.host || r.host.id === ref.host);
    });
    if (!matches.length) return { ok: false, error: `${ref.repo} isn't one of your repos: add it first (work config add <alias> <path>).` };
    // A target named beside a link must hold it: the repo itself, or a group with it among its repos.
    const within = target ? (config.groups?.[target] ?? [target]) : matches;
    alias = matches.find((a) => within.includes(a));
    if (!alias) return { ok: false, error: `PR #${ref.number} is in ${matches.join(' / ')} (${ref.repo}), not ${target}.` };
  } else {
    if (!target) return { ok: false, error: `PR #${ref.number}: which repo? Give its link, or pick the repo.` };
    if (config.groups?.[target])
      return { ok: false, error: `${target} is a group: a PR is one repo's. Give its link, or one of the group's repos.` };
    if (!config.repos[target]) return { ok: false, error: `${target} isn't one of your repos.` };
    alias = target;
  }
  const { host, id: repoId } = repoOf(alias);
  if (!repoId) {
    return { ok: false, error: `${alias}'s origin isn't a ${host.name} repo work can read: it can only look up PRs on a host it knows.` };
  }

  const view = await host.prByNumber(run, config.repos[alias], repoId, ref.number);
  if (!view.ok) return { ok: false, error: view.error };
  const pr = view.pr;
  if (pr.state && pr.state !== 'OPEN') return { ok: false, error: `PR #${ref.number} is ${pr.state.toLowerCase()}.` };
  if (pr.fork) {
    return {
      ok: false,
      error: `PR #${ref.number} comes from a fork (${pr.fork.owner}): its branch isn't on origin, so a session couldn't push to it.`,
    };
  }
  if (!pr.branch) return { ok: false, error: `PR #${ref.number}: ${host.cli.cmd} didn't say its branch.` };
  const stale = await localGoneOtherWay(run, config.repos[alias], pr.branch, pr.headSha);
  if (stale) return { ok: false, error: stale };
  return {
    ok: true,
    pr: {
      alias,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.branch,
      base: pr.base,
      author: pr.author,
      // Absent for GitHub (the wire's default), so a reader from before hosts sees what it always did.
      ...(host.id === DEFAULT_HOST ? {} : { host: host.id }),
    },
  };
}

/**
 * `work tree` takes a local branch of that name over origin's, moving it
 * forward when it can. One that has gone another way than the PR (the author
 * force-pushed, or an unrelated branch of the same name) would open on the
 * wrong commits, and what's pushed from it wouldn't go. Ahead (your commits
 * on top) or behind (it fast-forwards) is fine; when git can't tell (no
 * fetch), the usual warning on entering is left to say it.
 */
async function localGoneOtherWay(run: CommandRunner, repoPath: string, branch: string, headOid?: string): Promise<string | null> {
  if (!headOid) return null;
  const local = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath);
  if (local.code !== 0) return null;
  await run('git', ['fetch', '--quiet', 'origin', branch], repoPath);
  const contains = await run('git', ['merge-base', '--is-ancestor', headOid, `refs/heads/${branch}`], repoPath);
  if (contains.code === 0) return null;
  const behind = await run('git', ['merge-base', '--is-ancestor', `refs/heads/${branch}`, headOid], repoPath);
  if (behind.code !== 1 || contains.code !== 1) return null; // 1 = not an ancestor; anything else: git couldn't say
  return `Your local branch ${branch} and the PR's have gone separate ways (a force-push, or another branch of that name): rename yours (git branch -m ${branch} ${branch}-old) and try again, or go into its session as it is (work tree <repo> ${branch}).`;
}
