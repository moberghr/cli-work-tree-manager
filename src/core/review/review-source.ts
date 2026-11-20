import type { CommandRunner } from '../platform/command-runner.js';
import type { GitHost, HostResult } from '../hosts/types.js';
import { parseGitDiff, type ParsedFile } from '../diff/diff-parse.js';
import type { DiffExtras } from './review-build.js';

/**
 * A PR's code for its review, with no worktree and no session (#64): its
 * head fetched from origin into `refs/work/review/<n>` (the ref its host
 * names: GitHub's `refs/pull/<n>/head`; Azure DevOps' merge ref, whose second
 * parent is the head — the ref is moved there, so the review is read, and
 * its comments placed, at the PR's own commit), its base branch fetched, and
 * the diff from their merge-base. Reading a review never touches a checkout.
 * Git through the runner (argv only).
 */

export const reviewRef = (number: number) => `refs/work/review/${number}`;

export interface PreparedPr {
  files: ParsedFile[];
  extras: DiffExtras;
  mergeBase: string;
  /** The PR's head as fetched (never a merge commit): a push since the list was read moves it. */
  headSha: string;
}

/** How many paths one `git check-attr` gets: a big PR's every path on one command line passes Windows' limit. */
export const ATTR_CHUNK = 200;

const git = (run: CommandRunner, cwd: string, ...args: string[]) => run('git', args, cwd);

/** Fetch a PR's head and base, and diff them from their merge-base. */
export async function preparePr(
  run: CommandRunner,
  repoPath: string,
  host: Pick<GitHost, 'prRef' | 'prRefIsMerge'>,
  pr: { number: number; base: string },
): Promise<HostResult<PreparedPr>> {
  const ref = reviewRef(pr.number);
  const head = await git(run, repoPath, 'fetch', '--quiet', '--no-tags', 'origin', `+${host.prRef(pr.number)}:${ref}`);
  if (head.code !== 0)
    return { ok: false, error: `couldn't fetch the PR's code: ${head.stderr.trim().split('\n')[0] || 'git fetch failed'}` };
  if (host.prRefIsMerge) {
    // The PR merged into its target: its head is the merge's second parent. Point the ref there.
    const second = await git(run, repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^2`);
    const tip = second.stdout.trim();
    if (second.code !== 0 || !tip) return { ok: false, error: "the PR's merge ref has no second parent: can't tell its head" };
    const moved = await git(run, repoPath, 'update-ref', ref, tip);
    if (moved.code !== 0) return { ok: false, error: `couldn't keep the PR's head: ${moved.stderr.trim().split(/\r?\n/)[0]}` };
  }
  if (pr.base) await git(run, repoPath, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${pr.base}:refs/remotes/origin/${pr.base}`);
  const sha = (await git(run, repoPath, 'rev-parse', ref)).stdout.trim();
  const baseRef = pr.base ? `refs/remotes/origin/${pr.base}` : 'origin/HEAD';
  const mb = await git(run, repoPath, 'merge-base', baseRef, ref);
  if (mb.code !== 0 || !mb.stdout.trim()) return { ok: false, error: `no common commit with ${pr.base || 'the default branch'}` };
  const mergeBase = mb.stdout.trim();
  const files = await reviewDiff(run, repoPath, mergeBase, ref);
  if (!files) return { ok: false, error: "git couldn't diff the PR" };
  return { ok: true, files, extras: await diffExtras(run, repoPath, mergeBase, ref, files), mergeBase, headSha: sha };
}

/** The PR's diff (renames found), as the review and its view read it; null when git fails. */
export async function reviewDiff(run: CommandRunner, repoPath: string, from: string, to: string): Promise<ParsedFile[] | null> {
  const d = await git(run, repoPath, 'diff', '--no-color', '--no-ext-diff', '-M', from, to);
  return d.code === 0 ? parseGitDiff(d.stdout) : null;
}

/** Whitespace-only files (absent from `git diff -w`) and those `.gitattributes` marks linguist-generated. */
export async function diffExtras(run: CommandRunner, repoPath: string, from: string, to: string, files: ParsedFile[]): Promise<DiffExtras> {
  const changed = files.filter((f) => f.added + f.deleted > 0).map((f) => f.path);
  const w = await git(run, repoPath, 'diff', '--no-color', '--no-ext-diff', '-M', '-w', '--name-only', from, to);
  const real = new Set(
    w.code === 0
      ? w.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : changed,
  );
  const whitespaceOnly = new Set(w.code === 0 ? changed.filter((p) => !real.has(p)) : []);
  const generated = new Set<string>();
  // The PR's own .gitattributes (git 2.40's --source); an older git says nothing, and no file is marked.
  const paths = files.map((f) => f.path);
  for (let i = 0; i < paths.length; i += ATTR_CHUNK) {
    const attr = await git(run, repoPath, 'check-attr', `--source=${to}`, 'linguist-generated', '--', ...paths.slice(i, i + ATTR_CHUNK));
    if (attr.code !== 0) break;
    for (const line of attr.stdout.split('\n')) {
      const m = /^(.*): linguist-generated: (set|true)$/.exec(line.trim());
      if (m) generated.add(m[1]);
    }
  }
  return { whitespaceOnly, generated };
}

/** A review gone (its PR no longer open): its fetched code goes too, so the repo doesn't keep its objects alive. */
export async function dropReviewRef(run: CommandRunner, repoPath: string, number: number): Promise<void> {
  await git(run, repoPath, 'update-ref', '-d', reviewRef(number));
}
