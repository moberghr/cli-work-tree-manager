import type { BranchCandidate } from './api-types.js';
import { defaultRunner, type CommandRunner } from './ship.js';

/**
 * Local branches whose work is already in the main branch, left behind after
 * their PR merged. Offered for deletion only when that is certain:
 *
 *   - merged: `git branch --merged <origin's default>` lists it, or
 *   - squash-merged: its upstream is gone and GitHub has a MERGED PR whose
 *     head is exactly this branch's tip (a squash merge leaves no merge
 *     commit to find).
 *
 * Never offered: a branch checked out in any worktree, one a current (not
 * archived) session uses, the default branch, or a long-lived name (main,
 * master, dev, develop, staging, production, …). An archived session's
 * branch is offered with a warning: its Restore needs the branch.
 */

const LONG_LIVED = /^(main|master|dev|develop|development|staging|stage|production|prod|release|trunk)$/;

export interface BranchRepo {
  alias: string;
  path: string;
}

export interface BranchTidyDeps {
  repos: () => BranchRepo[];
  /** Branches sessions use, per repo alias → branch → the session. */
  sessionBranches: () => Map<string, Map<string, { id: string; archived: boolean }>>;
  run?: CommandRunner;
}

async function git(run: CommandRunner, cwd: string, ...args: string[]) {
  return run('git', ['-C', cwd, ...args], cwd);
}

/** origin's default branch as a ref (origin/main), else a local main/master. */
async function baseRef(run: CommandRunner, repo: string): Promise<string | null> {
  const head = await git(run, repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD');
  if (head.code === 0 && head.stdout.trim() && head.stdout.trim() !== 'origin/HEAD') return head.stdout.trim();
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(run, repo, 'rev-parse', '--verify', '--quiet', b)).code === 0) return b;
  }
  return null;
}

export async function findMergedBranches(deps: BranchTidyDeps): Promise<BranchCandidate[]> {
  const run = deps.run ?? defaultRunner;
  const sessions = deps.sessionBranches();
  const out: BranchCandidate[] = [];
  for (const repo of deps.repos()) {
    const base = await baseRef(run, repo.path);
    if (!base) continue;
    const baseName = base.replace(/^origin\//, '');
    const checkedOut = new Set(
      (await git(run, repo.path, 'worktree', 'list', '--porcelain')).stdout
        .split('\n')
        .map((l) => /^branch refs\/heads\/(.+)$/.exec(l.trim())?.[1])
        .filter((b): b is string => !!b),
    );
    const merged = new Set(
      (await git(run, repo.path, 'branch', '--merged', base, '--format=%(refname:short)')).stdout.split('\n').map((l) => l.trim()).filter(Boolean),
    );
    const refs = (await git(run, repo.path, 'for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(upstream:track)', 'refs/heads')).stdout
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((p) => p[0]);
    const used = sessions.get(repo.alias) ?? new Map();
    for (const [branch, tip, track] of refs) {
      if (branch === baseName || LONG_LIVED.test(branch) || checkedOut.has(branch)) continue;
      const session = used.get(branch);
      if (session && !session.archived) continue;
      let reason: BranchCandidate['reason'] | null = null;
      let prNumber: number | undefined;
      if (merged.has(branch)) reason = 'merged';
      else if ((track ?? '').includes('gone')) {
        const pr = await run('gh', ['pr', 'list', '--state', 'merged', '--head', branch, '--json', 'number,headRefOid', '--limit', '5'], repo.path);
        if (pr.code === 0) {
          try {
            const list = JSON.parse(pr.stdout) as Array<{ number: number; headRefOid: string }>;
            const hit = list.find((p) => p.headRefOid === tip);
            if (hit) {
              reason = 'squash-merged';
              prNumber = hit.number;
            }
          } catch {
            /* not JSON: not certain, not offered */
          }
        }
      }
      if (!reason) continue;
      out.push({
        repo: repo.alias, repoPath: repo.path, branch, tip, reason,
        ...(prNumber ? { prNumber } : {}),
        ...(session ? { archivedSession: session.id } : {}),
      });
    }
  }
  return out;
}

/**
 * Delete the chosen branches — each checked again first (still merged, still
 * not checked out, tip unchanged), then `git branch -D` (a squash merge is
 * not "merged" to git, so -d would refuse what we just verified).
 */
export async function deleteMergedBranches(
  chosen: Array<{ repo: string; branch: string }>,
  deps: BranchTidyDeps,
): Promise<Array<{ repo: string; branch: string; ok: boolean; message: string }>> {
  const run = deps.run ?? defaultRunner;
  const fresh = await findMergedBranches(deps);
  const results: Array<{ repo: string; branch: string; ok: boolean; message: string }> = [];
  for (const c of chosen) {
    const now = fresh.find((f) => f.repo === c.repo && f.branch === c.branch);
    if (!now) {
      results.push({ ...c, ok: false, message: 'Not deleted: no longer certain it is merged (or it is in use).' });
      continue;
    }
    const r = await git(run, now.repoPath, 'branch', '-D', now.branch);
    results.push({ ...c, ok: r.code === 0, message: r.code === 0 ? `Deleted (was ${now.tip.slice(0, 8)})` : r.stderr.trim() || 'git refused' });
  }
  return results;
}
