import fs from 'node:fs';
import path from 'node:path';
import type { CommandRunner } from './ship.js';
import type { CleanupAction, CleanupCandidate, CleanupRepo, CleanupState } from './api-types.js';
import { CLEANUP_MIN_IDLE_MS, cleanupVerdict } from './cleanup-verdict.js';

export { CLEANUP_ARCHIVE_AFTER_MS, CLEANUP_MIN_IDLE_MS, cleanupVerdict, type VerdictInput } from './cleanup-verdict.js';

/**
 * Worktree cleanup for the dashboard: which sessions can go, and why.
 *
 * `work prune` has the CLI version (synchronous, console output, one repo at
 * a time), fine for a terminal and far too slow to run inside work web over
 * hundreds of worktrees. This is the async one: facts per repo from a few
 * git calls (bounded concurrency), a pure verdict, and a job the Clean up
 * view polls.
 *
 * What "safe to delete" means here: every repo of the session is clean
 * (no uncommitted or untracked changes) and has nothing of its own that
 * origin's default branch doesn't have — merged, squash-merged, or never
 * committed to. `git worktree remove` keeps the branch, so even then no
 * commit is lost; the one thing a removal can destroy is uncommitted work,
 * which is exactly what is checked, and checked again right before acting.
 */

const lines = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean);
const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** origin's default branch as a ref this repo can use, or null. */
async function baseRef(cwd: string, run: CommandRunner): Promise<string | null> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const r = await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (r.code === 0) return ref;
  }
  return null;
}

/**
 * Is the branch's whole change already in `base` as one commit (GitHub's
 * squash merge)? Same trick as `work prune`: a throwaway commit of the
 * branch's tree on the merge-base, then `git cherry` for an equal patch.
 */
async function squashMerged(cwd: string, base: string, run: CommandRunner): Promise<boolean> {
  const mb = await run('git', ['merge-base', base, 'HEAD'], cwd);
  if (mb.code !== 0) return false;
  const tree = await run('git', ['rev-parse', 'HEAD^{tree}'], cwd);
  if (tree.code !== 0) return false;
  const dangling = await run('git', ['commit-tree', tree.stdout.trim(), '-p', mb.stdout.trim(), '-m', 'work cleanup check'], cwd);
  if (dangling.code !== 0) return false;
  const cherry = await run('git', ['cherry', base, dangling.stdout.trim()], cwd);
  return cherry.code === 0 && cherry.stdout.trim().startsWith('-');
}

/** The facts about one repo of a session that cleanup decides on. */
export async function repoFacts(
  name: string,
  worktreePath: string,
  baseCheckouts: Set<string>,
  run: CommandRunner,
): Promise<CleanupRepo> {
  const repo: CleanupRepo = { name, path: worktreePath, exists: false, readable: false, dirty: null, ahead: null, merged: null, base: null, baseCheckout: false };
  if (!fs.existsSync(worktreePath)) return repo;
  repo.exists = true;
  repo.baseCheckout = baseCheckouts.has(norm(worktreePath));
  const status = await run('git', ['status', '--porcelain'], worktreePath);
  if (status.code !== 0) return repo;
  repo.readable = true;
  repo.dirty = lines(status.stdout).length;
  repo.base = await baseRef(worktreePath, run);
  if (!repo.base) return repo;
  const ahead = await run('git', ['rev-list', '--count', `${repo.base}..HEAD`], worktreePath);
  if (ahead.code !== 0) return repo;
  repo.ahead = Number(ahead.stdout.trim()) || 0;
  repo.merged = repo.ahead === 0 ? 'contained' : (await squashMerged(worktreePath, repo.base, run)) ? 'squash' : null;
  return repo;
}

/** A session as the scanner needs it. */
export interface CleanupSession {
  id: string;
  target: string;
  branch: string;
  isGroup: boolean;
  paths: string[];
  archivedAt: string | null;
  lastActiveMs: number;
}

export interface CleanupDeps {
  sessions: () => CleanupSession[];
  /** Configured repo paths (a session there is the repo, not a worktree). */
  baseCheckouts: () => string[];
  /** Fetch these repos first, so "merged" is judged against today's origin. */
  fetchRepos: () => string[];
  run: CommandRunner;
  /** Carry out one checked action; throws with the reason on refusal. */
  act: (s: CleanupSession, action: CleanupAction) => Promise<void>;
  onChange?: () => void;
  now?: () => number;
  concurrency?: number;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Repo names for a session's paths: group sub-repo folders, else the target. */
function repoNames(s: CleanupSession): string[] {
  return s.isGroup ? s.paths.map((p) => path.basename(p)) : s.paths.map(() => s.target);
}

export interface CleanupJob {
  state(): CleanupState;
  /** Start a scan (no-op while one runs). */
  scan(): void;
  /** Apply chosen actions, each re-checked first (no-op while busy). */
  apply(items: Array<{ sessionId: string; action: CleanupAction }>): boolean;
  /** Resolves when idle — for tests. */
  idle(): Promise<void>;
}

export function createCleanupJob(deps: CleanupDeps): CleanupJob {
  const now = deps.now ?? Date.now;
  const concurrency = deps.concurrency ?? 6;
  let st: CleanupState = { phase: 'idle', done: 0, total: 0, candidates: [], results: [] };
  let running: Promise<void> = Promise.resolve();
  const changed = () => deps.onChange?.();

  const examine = async (s: CleanupSession, checkouts: Set<string>): Promise<CleanupCandidate> => {
    const names = repoNames(s);
    const repos = await Promise.all(s.paths.map((p, i) => repoFacts(names[i], p, checkouts, deps.run)));
    const v = cleanupVerdict({ repos, lastActiveMs: s.lastActiveMs, archived: !!s.archivedAt }, now());
    return {
      sessionId: s.id, target: s.target, branch: s.branch, isGroup: s.isGroup,
      lastActive: new Date(s.lastActiveMs).toISOString(), archivedAt: s.archivedAt,
      ...v, repos,
    };
  };

  const scan = async () => {
    const sessions = deps.sessions();
    const checkouts = new Set(deps.baseCheckouts().map(norm));
    st = { phase: 'fetching', done: 0, total: sessions.length, candidates: [], results: [], startedAt: new Date(now()).toISOString() };
    changed();
    await pool(deps.fetchRepos(), 4, async (repo) => {
      await deps.run('git', ['fetch', '--prune', '--quiet', 'origin'], repo);
    });
    st = { ...st, phase: 'scanning' };
    changed();
    const found: CleanupCandidate[] = [];
    // Newest first gets the "Used in the last day" ones out of the way cheaply.
    await pool(sessions, concurrency, async (s) => {
      const recent = now() - s.lastActiveMs < CLEANUP_MIN_IDLE_MS && s.paths.some((p) => fs.existsSync(p));
      if (!recent) {
        const c = await examine(s, checkouts);
        if (c.verdict !== 'keep') found.push(c);
      }
      st = { ...st, done: st.done + 1 };
      if (st.done % 10 === 0) changed();
    });
    found.sort((a, b) => a.lastActive.localeCompare(b.lastActive));
    st = { ...st, phase: 'idle', candidates: found, finishedAt: new Date(now()).toISOString() };
    changed();
  };

  const apply = async (items: Array<{ sessionId: string; action: CleanupAction }>) => {
    const byId = new Map(deps.sessions().map((s) => [s.id, s]));
    const checkouts = new Set(deps.baseCheckouts().map(norm));
    st = { ...st, phase: 'applying', done: 0, total: items.length, results: [] };
    changed();
    const done = new Set<string>();
    for (const it of items) {
      const s = byId.get(it.sessionId);
      let ok = false;
      let message: string;
      try {
        if (!s) throw new Error('The session is gone already.');
        // The scan may be minutes old: decide again on what is there now.
        const fresh = await examine(s, checkouts);
        if (it.action === 'delete' && fresh.verdict !== 'merged') throw new Error(`Not removed: ${fresh.reason}.`);
        if (it.action === 'forget' && fresh.verdict !== 'gone') throw new Error('Not forgotten: its folder exists again.');
        await deps.act(s, it.action);
        ok = true;
        message = it.action === 'delete' ? 'Worktree removed' : it.action === 'archive' ? 'Archived' : 'Forgotten';
        done.add(it.sessionId);
      } catch (err) {
        message = (err as Error).message;
      }
      st = { ...st, done: st.done + 1, results: [...st.results, { sessionId: it.sessionId, action: it.action, ok, message }] };
      changed();
    }
    st = { ...st, phase: 'idle', candidates: st.candidates.filter((c) => !done.has(c.sessionId)) };
    changed();
  };

  const busy = () => st.phase !== 'idle';
  return {
    state: () => st,
    scan() {
      if (busy()) return;
      running = scan().catch((err: Error) => {
        st = { ...st, phase: 'idle', error: err.message };
        changed();
      });
    },
    apply(items) {
      if (busy()) return false;
      running = apply(items).catch((err: Error) => {
        st = { ...st, phase: 'idle', error: err.message };
        changed();
      });
      return true;
    },
    idle: () => running,
  };
}
