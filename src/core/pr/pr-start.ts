import fs from 'node:fs';
import path from 'node:path';
import type { WorkConfig } from '../platform/config.js';
import { githubRepoOf } from './pr.js';
import { parsePrRef, type PrToStart } from './pr-ref.js';
import { defaultRunner, type CommandRunner } from './ship.js';

export type PrStartResult = { ok: true; pr: PrToStart } | { ok: false; error: string };

export interface PrStartDeps {
  run?: CommandRunner;
  /** A repo's `.git/config` text (tests pass their own). */
  gitConfig?: (repoPath: string) => string | null;
}

const readGitConfig = (repoPath: string): string | null => {
  try {
    return fs.readFileSync(path.join(repoPath, '.git', 'config'), 'utf-8');
  } catch {
    return null;
  }
};

/** The fields of `gh pr view --json …` this reads; all optional — it is someone else's output. */
interface GhPrView {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  state?: string;
  isCrossRepository?: boolean;
  author?: { login?: string } | null;
  headRepositoryOwner?: { login?: string } | null;
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
  const ref = parsePrRef(input);
  if (!ref) return { ok: false, error: 'Give a pull request link (https://github.com/owner/repo/pull/123), or its number with a repo.' };

  const repoOf = (alias: string) => githubRepoOf(gitConfig(config.repos[alias]) ?? '');
  let alias: string | undefined;
  if (ref.repo) {
    const matches = Object.keys(config.repos).filter((a) => repoOf(a) === ref.repo);
    alias = target && matches.includes(target) ? target : matches[0];
    if (!alias) return { ok: false, error: `${ref.repo} isn't one of your repos: add it first (work config add <alias> <path>).` };
  } else {
    if (!target) return { ok: false, error: `PR #${ref.number}: which repo? Give its link, or pick the repo.` };
    if (config.groups?.[target])
      return { ok: false, error: `${target} is a group: a PR is one repo's. Give its link, or one of the group's repos.` };
    if (!config.repos[target]) return { ok: false, error: `${target} isn't one of your repos.` };
    alias = target;
  }
  const github = repoOf(alias);
  if (!github) return { ok: false, error: `${alias} isn't on github.com: work can only look up GitHub PRs.` };

  const view = await run(
    'gh',
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      github,
      '--json',
      'number,title,url,headRefName,baseRefName,state,isCrossRepository,author,headRepositoryOwner',
    ],
    config.repos[alias],
  );
  if (view.code === 127) return { ok: false, error: 'GitHub CLI (gh) not found: install it to start from a PR.' };
  if (view.code !== 0)
    return { ok: false, error: `PR #${ref.number} in ${github}: ${view.stderr.trim().split('\n')[0] || 'gh pr view failed'}` };
  let pr: GhPrView;
  try {
    pr = JSON.parse(view.stdout) as GhPrView;
  } catch {
    return { ok: false, error: "Couldn't read what gh said about the PR." };
  }
  if (pr.state && pr.state !== 'OPEN') return { ok: false, error: `PR #${ref.number} is ${pr.state.toLowerCase()}.` };
  if (pr.isCrossRepository) {
    const owner = pr.headRepositoryOwner?.login ?? 'a fork';
    return {
      ok: false,
      error: `PR #${ref.number} comes from a fork (${owner}): its branch isn't on origin, so a session couldn't push to it.`,
    };
  }
  if (!pr.headRefName) return { ok: false, error: `PR #${ref.number}: gh didn't say its branch.` };
  return {
    ok: true,
    pr: {
      alias,
      number: pr.number ?? ref.number,
      title: pr.title ?? '',
      url: pr.url ?? '',
      branch: pr.headRefName,
      base: pr.baseRefName ?? '',
      author: pr.author?.login ?? '',
    },
  };
}
