import type { CommandRunner } from '../platform/command-runner.js';
import type { GitHost, HostResult } from '../hosts/types.js';
import { parseGitDiff, type ParsedFile } from '../diff/diff-parse.js';
import type { DiffExtras } from './review-build.js';

/**
 * A PR's code for its review, with no worktree and no session (#64): its
 * head fetched from origin into `refs/work/review/<n>` (the ref its host
 * names: GitHub's `refs/pull/<n>/head`), its base branch fetched, and the
 * diff from their merge-base. Reading a review never touches a checkout.
 * Git through the runner (argv only).
 */

export const reviewRef = (number: number) => `refs/work/review/${number}`;

export interface PreparedPr {
  files: ParsedFile[];
  extras: DiffExtras;
  mergeBase: string;
  /** The head as fetched: a push since the list was read moves it. */
  headSha: string;
}

const git = (run: CommandRunner, cwd: string, ...args: string[]) => run('git', args, cwd);

/** Fetch a PR's head and base, and diff them from their merge-base. */
export async function preparePr(
  run: CommandRunner,
  repoPath: string,
  host: Pick<GitHost, 'prRef'>,
  pr: { number: number; base: string },
): Promise<HostResult<PreparedPr>> {
  const ref = reviewRef(pr.number);
  const head = await git(run, repoPath, 'fetch', '--quiet', '--no-tags', 'origin', `+${host.prRef(pr.number)}:${ref}`);
  if (head.code !== 0)
    return { ok: false, error: `couldn't fetch the PR's code: ${head.stderr.trim().split('\n')[0] || 'git fetch failed'}` };
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
async function diffExtras(run: CommandRunner, repoPath: string, from: string, to: string, files: ParsedFile[]): Promise<DiffExtras> {
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
  if (files.length) {
    // The PR's own .gitattributes (git 2.40's --source); an older git says nothing, and no file is marked.
    const attr = await git(run, repoPath, 'check-attr', `--source=${to}`, 'linguist-generated', '--', ...files.map((f) => f.path));
    if (attr.code === 0)
      for (const line of attr.stdout.split('\n')) {
        const m = /^(.*): linguist-generated: (set|true)$/.exec(line.trim());
        if (m) generated.add(m[1]);
      }
  }
  return { whitespaceOnly, generated };
}
