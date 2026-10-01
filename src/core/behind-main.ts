import path from 'node:path';
import { defaultRunner, type CommandRunner } from './ship.js';
import { logSwallowed } from './best-effort.js';

/**
 * How far a session's branch has fallen behind its main branch, and whether
 * merging main would conflict — so the dashboard can say "↓ 34 behind
 * origin/main · conflicts" before it bites at merge time — and "Update from
 * main" to catch up. Against the last fetched `origin/HEAD` (nothing here
 * fetches but the update itself). Git through a CommandRunner: argv only.
 */

export interface Behind {
  /** origin/<main>, as the repo's origin/HEAD says. */
  base: string;
  commits: number;
  /** Merging base would conflict (git merge-tree, no worktree touched).
   *  False also when it couldn't tell (git before 2.38 has no --write-tree):
   *  nothing ever claims "no conflicts", only says so when they're found. */
  conflicts: boolean;
}

/** One repo; null when it has no origin/HEAD (nothing to compare with). */
export async function behindMain(repo: string, run: CommandRunner = defaultRunner): Promise<Behind | null> {
  const head = await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], repo);
  const base = head.code === 0 ? head.stdout.trim() : '';
  if (!base || base === 'origin/HEAD') return null;
  const count = await run('git', ['-C', repo, 'rev-list', '--count', `HEAD..${base}`], repo);
  const commits = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
  if (commits === 0) return { base, commits: 0, conflicts: false };
  // Exit 1: the merge would conflict; 0: clean. Anything else (an old git's
  // usage error): can't tell, so no warning.
  const merge = await run('git', ['-C', repo, 'merge-tree', '--write-tree', '--quiet', 'HEAD', base], repo);
  return { base, commits, conflicts: merge.code === 1 };
}

/** Several repos (a group): the furthest behind, and any conflict. */
export function combineBehind(list: Array<Behind | null>): Behind | null {
  const known = list.filter((b): b is Behind => b !== null);
  if (known.length === 0) return null;
  const worst = known.reduce((a, b) => (b.commits > a.commits ? b : a));
  return { base: worst.base, commits: worst.commits, conflicts: known.some((b) => b.conflicts) };
}

/**
 * Per session, refreshed in the background (slowly: main moves slowly, and
 * merge-tree costs a little), a couple at a time; reads never wait.
 */
export class BehindCache {
  private readonly entries = new Map<string, { value: Behind | null; at: number; inFlight: boolean }>();
  private running = 0;
  private readonly queue: Array<{ id: string; paths: string[] }> = [];

  constructor(
    private readonly opts: { ttlMs?: number; concurrency?: number; run?: CommandRunner; onChange?: () => void; now?: () => number } = {},
  ) {}

  get(id: string, paths: string[]): Behind | null {
    const now = (this.opts.now ?? Date.now)();
    const e = this.entries.get(id);
    if (!e || (!e.inFlight && now - e.at > (this.opts.ttlMs ?? 10 * 60_000))) this.schedule(id, paths);
    return e?.value ?? null;
  }

  /** Look again soon (the branch moved: an update, a pull). */
  invalidate(id: string): void {
    const e = this.entries.get(id);
    if (e) e.at = 0;
  }

  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private schedule(id: string, paths: string[]): void {
    const e = this.entries.get(id) ?? { value: null, at: 0, inFlight: false };
    if (e.inFlight) return;
    e.inFlight = true;
    this.entries.set(id, e);
    this.queue.push({ id, paths });
    this.pump();
  }

  private pump(): void {
    while (this.running < (this.opts.concurrency ?? 2) && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      Promise.all(job.paths.map((p) => behindMain(p, this.opts.run)))
        .then(combineBehind)
        .catch((err) => {
          logSwallowed(`behind main for ${job.id}`, err);
          return null;
        })
        .then((value) => {
          const e = this.entries.get(job.id)!;
          const changed = JSON.stringify(e.value) !== JSON.stringify(value);
          e.value = value;
          e.at = (this.opts.now ?? Date.now)();
          e.inFlight = false;
          if (changed) this.opts.onChange?.();
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

// ---- Update from main ------------------------------------------------------------

export type UpdateResult =
  | { ok: true; repo: string; how: 'rebase' | 'merge' | 'nothing'; base: string; commits: number }
  | { ok: false; repo: string; reason: string; conflicts?: boolean; base?: string };

/**
 * Bring one repo's branch up to date with origin/<main>: fetch, then rebase
 * a branch that was never pushed, or merge main into a published one (a
 * rebase would need a force push, which Ship doesn't do). Never with
 * uncommitted changes. A conflict is aborted at once — the worktree is left
 * as it was — and reported, for Claude to resolve.
 */
export async function updateFromMain(repo: string, run: CommandRunner = defaultRunner): Promise<UpdateResult> {
  const name = path.basename(repo);
  const git = (...args: string[]) => run('git', ['-C', repo, ...args], repo);
  const dirty = await git('status', '--porcelain');
  if (dirty.code !== 0) return { ok: false, repo: name, reason: dirty.stderr.trim() || 'not a git checkout' };
  if (dirty.stdout.trim()) return { ok: false, repo: name, reason: 'it has uncommitted changes: commit or stash them first' };
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  if (!branch || branch === 'HEAD') return { ok: false, repo: name, reason: 'not on a branch (detached HEAD)' };
  await git('fetch', '--quiet', 'origin');
  const head = (await git('rev-parse', '--abbrev-ref', 'origin/HEAD')).stdout.trim();
  if (!head || head === 'origin/HEAD') return { ok: false, repo: name, reason: 'no origin/HEAD to update from (git remote set-head origin -a)' };
  const commits = Number((await git('rev-list', '--count', `HEAD..${head}`)).stdout.trim()) || 0;
  if (commits === 0) return { ok: true, repo: name, how: 'nothing', base: head, commits: 0 };
  const published = (await git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)).code === 0;
  const how = published ? 'merge' : 'rebase';
  const r = published ? await git('merge', '--no-edit', head) : await git('rebase', head);
  if (r.code === 0) return { ok: true, repo: name, how, base: head, commits };
  // A conflict leaves unmerged paths; anything else (a hook refusing the
  // commit, signing) doesn't, and isn't one for Claude to resolve.
  const unmerged = (await git('diff', '--name-only', '--diff-filter=U')).stdout.trim() !== '';
  await git(how, '--abort');
  const verb = published ? `merging ${head}` : `rebasing on ${head}`;
  if (unmerged) return { ok: false, repo: name, reason: `${verb} conflicts`, conflicts: true, base: head };
  return { ok: false, repo: name, reason: `${verb} failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `git exited ${r.code}`}`, base: head };
}

/** What went wrong, in its first words (a hook's own message comes before git's "Not committing merge"). */
const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('hint:')) ?? '';
