import path from 'node:path';
import { updateFromMain, type UpdateResult } from './behind-main.js';
import type { WorkConfig } from './config.js';
import { readArchive } from './session-archive.js';
import { defaultRunner, type CommandRunner } from './ship.js';
import type { WorktreeSession } from './session-types.js';
import type { StackedSession } from './stack-sessions.js';

/**
 * A stacked session (stack.ts) whose parent merged — its session archived —
 * moves onto main. Its branch still holds the parent's commits, which main
 * now has in another form (a squash merge), so a plain rebase would replay
 * them: `git rebase --onto origin/<main> <fork point>` replays only its own
 * commits, the fork point being where it left the parent (the parent's
 * branch, or the tip its archive recorded). A branch already pushed isn't
 * rewritten: main is merged into it, as Update from main does. Git through
 * a CommandRunner: argv only.
 */

/** The parent's tip in this repo: its branch if it is still there, else what its archive recorded. */
export async function parentTipFor(
  repo: string,
  parent: Pick<StackedSession, 'id' | 'branch' | 'target' | 'isGroup'>,
  config: WorkConfig | null,
  run: CommandRunner = defaultRunner,
): Promise<string | null> {
  const ref = await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${parent.branch}`], repo);
  if (ref.code === 0 && ref.stdout.trim()) return ref.stdout.trim();
  const tips = readArchive(parent.id)?.tips ?? {};
  if (!parent.isGroup) return tips[parent.target] ?? Object.values(tips)[0] ?? null;
  // A group's repos: the alias whose checkout folder this is.
  const alias = Object.entries(config?.repos ?? {}).find(([a, p]) => path.basename(p) === path.basename(repo) && a in tips)?.[0];
  return alias ? tips[alias] : null;
}

interface Plan {
  repo: string;
  name: string;
  branch: string;
  head: string;
  /** The commit it left the parent at. */
  fork: string;
  published: boolean;
}

async function plan(repo: string, parentTip: string, run: CommandRunner, fetch: boolean): Promise<Plan | { error: string }> {
  const git = (...args: string[]) => run('git', ['-C', repo, ...args], repo);
  const name = path.basename(repo);
  const st = await git('status', '--porcelain');
  if (st.code !== 0) return { error: `${name}: ${st.stderr.trim() || 'not a git checkout'}` };
  if (st.stdout.trim()) return { error: `${name}: it has uncommitted changes: commit or stash them first` };
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  if (!branch || branch === 'HEAD') return { error: `${name}: not on a branch (detached HEAD)` };
  if (fetch) await git('fetch', '--quiet', 'origin');
  const head = (await git('rev-parse', '--abbrev-ref', 'origin/HEAD')).stdout.trim();
  if (!head || head === 'origin/HEAD') return { error: `${name}: no origin/HEAD to move onto (git remote set-head origin -a)` };
  const fork = (await git('merge-base', 'HEAD', parentTip)).stdout.trim();
  if (!fork) return { error: `${name}: it has nothing in common with the parent's branch` };
  const published = (await git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)).code === 0;
  return { repo, name, branch, head, fork, published };
}

/** Would it move cleanly? (git merge-tree, nothing touched; false when git can't tell.) */
export async function retargetIsClean(repo: string, parentTip: string, run: CommandRunner = defaultRunner): Promise<boolean> {
  const p = await plan(repo, parentTip, run, false);
  if ('error' in p) return false;
  const args = p.published
    ? ['merge-tree', '--write-tree', '--quiet', 'HEAD', p.head]
    : ['merge-tree', '--write-tree', '--quiet', `--merge-base=${p.fork}`, p.head, 'HEAD'];
  return (await run('git', ['-C', repo, ...args], repo)).code === 0;
}

/**
 * Move every repo of the session onto main, all or nothing: a repo that
 * fails puts back the ones already moved (they were clean). Refuses a dirty
 * repo, a detached HEAD, a repo it can't find the parent in.
 */
export async function retargetOntoMain(
  child: WorktreeSession,
  tipOf: (repo: string) => Promise<string | null>,
  run: CommandRunner = defaultRunner,
): Promise<{ ok: boolean; results: UpdateResult[]; base?: string }> {
  const plans: Plan[] = [];
  for (const repo of child.paths) {
    const tip = await tipOf(repo);
    if (!tip) return { ok: false, results: [{ ok: false, repo: path.basename(repo), reason: "the parent's branch is gone and its archive has no tip for it" }] };
    const p = await plan(repo, tip, run, true);
    if ('error' in p) return { ok: false, results: [{ ok: false, repo: path.basename(repo), reason: p.error.replace(/^[^:]+: /, '') }] };
    plans.push(p);
  }
  const before = new Map<string, string>();
  for (const p of plans) before.set(p.repo, (await run('git', ['-C', p.repo, 'rev-parse', 'HEAD'], p.repo)).stdout.trim());
  const results: UpdateResult[] = [];
  const moved: string[] = [];
  const putBack = async () => {
    for (const repo of moved) await run('git', ['-C', repo, 'reset', '--hard', '--quiet', before.get(repo)!], repo);
  };
  for (const p of plans) {
    const git = (...args: string[]) => run('git', ['-C', p.repo, ...args], p.repo);
    const commits = Number((await git('rev-list', '--count', `${p.fork}..${p.head}`)).stdout.trim()) || 0;
    let r: UpdateResult;
    if (p.published) {
      // Pushed: not rewritten (no force push) — main merged in, as Update from main does.
      r = await updateFromMain(p.repo, run);
    } else {
      const rb = await git('rebase', '--onto', p.head, p.fork);
      if (rb.code === 0) r = { ok: true, repo: p.name, how: 'rebase', base: p.head, commits };
      else {
        const unmerged = (await git('diff', '--name-only', '--diff-filter=U')).stdout.trim() !== '';
        await git('rebase', '--abort');
        r = unmerged
          ? { ok: false, repo: p.name, reason: `moving onto ${p.head} conflicts`, conflicts: true, base: p.head }
          : { ok: false, repo: p.name, reason: `moving onto ${p.head} failed: ${rb.stderr.trim().split(/\r?\n/)[0] || `git exited ${rb.code}`}`, base: p.head };
      }
    }
    if (!r.ok) {
      await putBack();
      return { ok: false, results: [...results.map((x): UpdateResult => ({ ok: false, repo: x.repo, reason: 'put back as it was', base: x.ok ? x.base : undefined })), r] };
    }
    results.push(r);
    moved.push(p.repo);
  }
  return { ok: true, results, base: plans[0]?.head };
}
