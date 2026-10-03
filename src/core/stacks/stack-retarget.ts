import path from 'node:path';
import { updateFromMain, type UpdateResult } from './behind-main.js';
import type { WorkConfig } from '../platform/config.js';
import { readArchive } from '../archive/session-archive.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import type { WorktreeSession } from '../sessions/session-types.js';
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
  // (Only the group's own: another project's repo may have the same folder name.)
  const own = config?.groups[parent.target] ?? [];
  const alias = own.find((a) => a in tips && !!config?.repos[a] && path.basename(config.repos[a]) === path.basename(repo));
  return alias ? tips[alias] : null;
}

/** Where to start replaying from, and how. */
export interface Fork {
  /** The commit it left the parent at (replay what came after). */
  fork: string;
  /** `plain`: the parent's tip is in main (a real merge), so `git rebase <main>` drops the parent's commits by itself. */
  plain: boolean;
}

interface Plan extends Fork {
  repo: string;
  name: string;
  branch: string;
  head: string;
  published: boolean;
}

/**
 * Where the branch left its parent. Not simply merge-base with the parent's
 * tip: a parent rebased or amended before it merged shares only an older
 * commit with the child, and replaying from there would bring the parent's
 * old commits back. So: a parent whose tip is in main (a real merge) needs no
 * fork point (a plain rebase); otherwise git's --fork-point (the parent
 * branch's reflog remembers where it was, even rewritten); otherwise the tip,
 * when the branch is built on it. Else it can't tell, and says so.
 * (--fork-point is a reflog heuristic: git documents that an unrelated
 * reflog entry can mislead it. A fork point from it is still one the child
 * is built on, so at worst a commit too few or too many of the parent's
 * comes along — and a conflict is aborted, never left.)
 */
export async function forkPoint(
  repo: string,
  parent: { branch: string; tip: string },
  main: string,
  run: CommandRunner = defaultRunner,
): Promise<Fork | { error: string; handOff?: boolean }> {
  const git = (...args: string[]) => run('git', ['-C', repo, ...args], repo);
  if ((await git('merge-base', '--is-ancestor', parent.tip, main)).code === 0) {
    const base = (await git('merge-base', 'HEAD', main)).stdout.trim();
    return base ? { fork: base, plain: true } : { error: 'it has nothing in common with main' };
  }
  if ((await git('rev-parse', '--verify', '--quiet', `refs/heads/${parent.branch}`)).code === 0) {
    const fp = await git('merge-base', '--fork-point', `refs/heads/${parent.branch}`, 'HEAD');
    if (fp.code === 0 && fp.stdout.trim()) return { fork: fp.stdout.trim(), plain: false };
  }
  if ((await git('merge-base', '--is-ancestor', parent.tip, 'HEAD')).code === 0) return { fork: parent.tip, plain: false };
  return {
    error: `${parent.branch} was rewritten (rebased or amended) after this branched off, and git can't tell which commits are this branch's own: ask its Claude to move it onto main`,
    handOff: true,
  };
}

async function plan(
  repo: string,
  parent: { branch: string; tip: string },
  run: CommandRunner,
  fetch: boolean,
): Promise<Plan | { error: string; handOff?: boolean; base?: string }> {
  const git = (...args: string[]) => run('git', ['-C', repo, ...args], repo);
  const name = path.basename(repo);
  const st = await git('status', '--porcelain');
  if (st.code !== 0) return { error: st.stderr.trim() || 'not a git checkout' };
  if (st.stdout.trim()) return { error: 'it has uncommitted changes: commit or stash them first' };
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  if (!branch || branch === 'HEAD') return { error: 'not on a branch (detached HEAD)' };
  if (fetch) await git('fetch', '--quiet', 'origin');
  const head = (await git('rev-parse', '--abbrev-ref', 'origin/HEAD')).stdout.trim();
  if (!head || head === 'origin/HEAD') return { error: 'no origin/HEAD to move onto (git remote set-head origin -a)' };
  const f = await forkPoint(repo, parent, head, run);
  if ('error' in f) return { ...f, base: head };
  const published = (await git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)).code === 0;
  return { repo, name, branch, head, published, ...f };
}

/** Why it can't be moved by git alone, if so: the parent was rewritten and the fork point is unknown (hand it to Claude). */
export async function retargetBlocker(
  repo: string,
  parent: { branch: string; tip: string },
  run: CommandRunner = defaultRunner,
): Promise<{ reason: string; handOff: boolean } | null> {
  const p = await plan(repo, parent, run, false);
  return 'error' in p ? { reason: p.error, handOff: !!p.handOff } : null;
}

/**
 * Would it move cleanly? (git merge-tree, nothing touched.) False when git
 * can't tell — `--merge-base` needs git 2.40 — so the automatic move never
 * runs on an older git; the button still works.
 */
export async function retargetIsClean(
  repo: string,
  parent: { branch: string; tip: string },
  run: CommandRunner = defaultRunner,
): Promise<boolean> {
  const p = await plan(repo, parent, run, false);
  if ('error' in p) return false;
  const args =
    p.published || p.plain
      ? ['merge-tree', '--write-tree', '--quiet', 'HEAD', p.head]
      : ['merge-tree', '--write-tree', '--quiet', `--merge-base=${p.fork}`, p.head, 'HEAD'];
  return (await run('git', ['-C', repo, ...args], repo)).code === 0;
}

export interface RetargetResult {
  ok: boolean;
  results: UpdateResult[];
  /** Each repo's main now (path → `main`), when it moved. */
  bases?: Record<string, string>;
}

/**
 * Move every repo of the session onto main, all or nothing: a repo that
 * fails puts back the ones already moved (they were clean). Refuses a dirty
 * repo, a detached HEAD, a repo it can't find the parent in, and stops when
 * `stillOk` says no right before a repo is changed (a turn started).
 */
export async function retargetOntoMain(
  child: WorktreeSession,
  parentOf: (repo: string) => Promise<{ branch: string; tip: string | null }>,
  run: CommandRunner = defaultRunner,
  stillOk: () => string | null = () => null,
): Promise<RetargetResult> {
  const plans: Plan[] = [];
  for (const repo of child.paths) {
    const parent = await parentOf(repo);
    if (!parent.tip)
      return {
        ok: false,
        results: [{ ok: false, repo: path.basename(repo), reason: `${parent.branch} is gone and its archive has no tip for this repo` }],
      };
    const p = await plan(repo, { branch: parent.branch, tip: parent.tip }, run, true);
    if ('error' in p)
      return {
        ok: false,
        results: [
          { ok: false, repo: path.basename(repo), reason: p.error, ...(p.handOff ? { handOff: true, base: p.base ?? 'origin/main' } : {}) },
        ],
      };
    plans.push(p);
  }
  const before = new Map<string, string>();
  for (const p of plans) before.set(p.repo, (await run('git', ['-C', p.repo, 'rev-parse', 'HEAD'], p.repo)).stdout.trim());
  const results: UpdateResult[] = [];
  const moved: string[] = [];
  const putBack = async () => {
    for (const repo of moved) await run('git', ['-C', repo, 'reset', '--hard', '--quiet', before.get(repo)!], repo);
  };
  const fail = async (r: UpdateResult): Promise<RetargetResult> => {
    await putBack();
    return {
      ok: false,
      results: [
        ...results.map((x): UpdateResult => ({ ok: false, repo: x.repo, reason: 'put back as it was', base: x.ok ? x.base : undefined })),
        r,
      ],
    };
  };
  for (const p of plans) {
    const busy = stillOk();
    if (busy) return fail({ ok: false, repo: p.name, reason: busy });
    const git = (...args: string[]) => run('git', ['-C', p.repo, ...args], p.repo);
    const commits = Number((await git('rev-list', '--count', `${p.fork}..${p.head}`)).stdout.trim()) || 0;
    let r: UpdateResult;
    if (p.published) {
      // Pushed: not rewritten (no force push) — main merged in, as Update from main does.
      r = await updateFromMain(p.repo, run);
    } else {
      const rb = p.plain ? await git('rebase', p.head) : await git('rebase', '--onto', p.head, p.fork);
      if (rb.code === 0) r = { ok: true, repo: p.name, how: 'rebase', base: p.head, commits };
      else {
        const unmerged = (await git('diff', '--name-only', '--diff-filter=U')).stdout.trim() !== '';
        await git('rebase', '--abort');
        r = unmerged
          ? { ok: false, repo: p.name, reason: `moving onto ${p.head} conflicts`, conflicts: true, base: p.head }
          : {
              ok: false,
              repo: p.name,
              reason: `moving onto ${p.head} failed: ${rb.stderr.trim().split(/\r?\n/)[0] || `git exited ${rb.code}`}`,
              base: p.head,
            };
      }
    }
    if (!r.ok) return fail(r);
    results.push(r);
    moved.push(p.repo);
  }
  return { ok: true, results, bases: Object.fromEntries(plans.map((p) => [p.repo, p.head.replace(/^origin\//, '')])) };
}
