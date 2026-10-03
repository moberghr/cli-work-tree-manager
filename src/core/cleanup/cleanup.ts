import fs from 'node:fs';
import path from 'node:path';
import type { CommandRunner } from '../pr/ship.js';
import type { CleanupAction, CleanupCandidate, CleanupRepo, CleanupState } from '../api-types.js';
import { CLEANUP_MIN_IDLE_MS, cleanupVerdict } from './cleanup-verdict.js';

export { CLEANUP_ARCHIVE_AFTER_MS, CLEANUP_MIN_IDLE_MS, cleanupVerdict, type VerdictInput } from './cleanup-verdict.js';

/**
 * Which worktrees can go, and why — the one implementation behind the Clean
 * up view, `work prune`, `work sync` and `work cleanup`.
 *
 * Facts per repo come from a few git calls (bounded concurrency), the
 * verdict is pure (cleanup-verdict.ts). "Safe to remove" means every repo of
 * the worktree is clean (nothing uncommitted or untracked) and has nothing
 * of its own that the main branch doesn't — merged, squash-merged, or never
 * committed to. `git worktree remove` keeps the branch, so no commit is ever
 * lost; the one thing a removal can destroy is uncommitted work, which is
 * what is checked — and checked again right before acting.
 *
 * Worktrees are the sessions in work's history plus, from git, worktrees it
 * doesn't know (`untracked`: made by hand, or before history existed).
 */

const lines = (out: string) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
export const normPath = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** The main branch to compare with: origin's default, else a local one
 *  (a repo with no remote — tests, scratch repos). */
async function baseRef(cwd: string, run: CommandRunner): Promise<string | null> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    const r = await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (r.code === 0) return ref;
  }
  return null;
}

/**
 * Is the branch's whole change already in `base` as one commit (GitHub's
 * squash merge)? A throwaway commit of the branch's tree on the merge-base,
 * then `git cherry` for an equal patch.
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

/** The facts about one repo of a worktree that cleanup decides on. */
export async function repoFacts(name: string, worktreePath: string, baseCheckouts: Set<string>, run: CommandRunner): Promise<CleanupRepo> {
  const repo: CleanupRepo = {
    name,
    path: worktreePath,
    exists: false,
    readable: false,
    dirty: null,
    ahead: null,
    merged: null,
    base: null,
    baseCheckout: false,
  };
  if (!fs.existsSync(worktreePath)) return repo;
  repo.exists = true;
  repo.baseCheckout = baseCheckouts.has(normPath(worktreePath));
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

/** A worktree as cleanup needs it: a history session, or one only git knows. */
export interface CleanupSession {
  id: string;
  target: string;
  branch: string;
  isGroup: boolean;
  paths: string[];
  archivedAt: string | null;
  /** Newest sign of life; 0 = unknown (an untracked worktree). */
  lastActiveMs: number;
  /** Repo aliases it belongs to — to skip the ones whose fetch failed. */
  aliases: string[];
  /** Not in work's history: found by git. It has no session to archive. */
  untracked?: boolean;
}

export interface CleanupDeps {
  /** History sessions plus untracked worktrees (see cleanup-deps.ts). */
  sessions: () => Promise<CleanupSession[]> | CleanupSession[];
  /** Configured repo paths (a session there is the repo, not a worktree). */
  baseCheckouts: () => string[];
  /** Fetch these first, so "merged" is judged against today's origin. */
  fetchRepos: () => Array<{ alias: string; path: string }>;
  /** Fetch one repo; throws when it fails. */
  fetch: (repoPath: string) => Promise<void>;
  run: CommandRunner;
  /** Carry out one checked action; throws with the reason on refusal. */
  act: (s: CleanupSession, action: CleanupAction) => Promise<void>;
  now?: () => number;
  concurrency?: number;
}

export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Repo names for a worktree's paths: group sub-repo folders, else the target. */
function repoNames(s: CleanupSession): string[] {
  return s.isGroup ? s.paths.map((p) => path.basename(p)) : s.paths.map(() => s.target);
}

/**
 * Base-checkout entries that are duplicates: several sessions for one
 * configured repo's own folder (each recorded when that checkout was on a
 * different branch). The most recently used is the entry; the rest map to it.
 */
export function duplicateBaseEntries(sessions: CleanupSession[], baseCheckouts: string[]): Map<string, { branch: string }> {
  const bases = new Set(baseCheckouts.map(normPath));
  const byPath = new Map<string, CleanupSession[]>();
  for (const s of sessions) {
    if (s.untracked || s.isGroup || s.paths.length !== 1 || !bases.has(normPath(s.paths[0]))) continue;
    const key = `${s.target}|${normPath(s.paths[0])}`;
    byPath.set(key, [...(byPath.get(key) ?? []), s]);
  }
  const dupes = new Map<string, { branch: string }>();
  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    const [kept, ...rest] = [...group].sort((a, b) => b.lastActiveMs - a.lastActiveMs);
    for (const s of rest) dupes.set(s.id, { branch: kept.branch });
  }
  return dupes;
}

/** One worktree, examined now. */
export async function examineWorktree(
  s: CleanupSession,
  deps: Pick<CleanupDeps, 'baseCheckouts' | 'run' | 'now'>,
  duplicateOf?: { branch: string },
): Promise<CleanupCandidate> {
  const checkouts = new Set(deps.baseCheckouts().map(normPath));
  const names = repoNames(s);
  const repos = await Promise.all(s.paths.map((p, i) => repoFacts(names[i], p, checkouts, deps.run)));
  const v = cleanupVerdict({ repos, lastActiveMs: s.lastActiveMs, archived: !!s.archivedAt, duplicateOf }, (deps.now ?? Date.now)());
  // Nothing to archive for a worktree work doesn't track.
  const suggested = s.untracked && v.suggested === 'archive' ? null : v.suggested;
  return {
    sessionId: s.id,
    target: s.target,
    branch: s.branch,
    isGroup: s.isGroup,
    lastActive: new Date(s.lastActiveMs).toISOString(),
    archivedAt: s.archivedAt,
    ...v,
    suggested,
    repos,
  };
}

export interface ScanOptions {
  /** Fetch the repos first (default true). */
  fetch?: boolean;
  onPhase?: (phase: 'fetching' | 'scanning', total: number) => void;
  onProgress?: (done: number) => void;
}

export interface ScanResult {
  candidates: CleanupCandidate[];
  /** Aliases whose fetch failed: their worktrees were not judged (stale refs). */
  fetchFailed: Array<{ alias: string; error: string }>;
  checked: number;
}

/** Every worktree that isn't a 'keep', oldest first. */
export async function scanCleanup(deps: CleanupDeps, opts: ScanOptions = {}): Promise<ScanResult> {
  const now = deps.now ?? Date.now;
  const sessions = await deps.sessions();
  const fetchFailed: ScanResult['fetchFailed'] = [];
  if (opts.fetch !== false) {
    const repos = deps.fetchRepos();
    opts.onPhase?.('fetching', repos.length);
    await pool(repos, 4, async (r) => {
      try {
        await deps.fetch(r.path);
      } catch (err) {
        fetchFailed.push({ alias: r.alias, error: (err as Error).message });
      }
    });
  }
  const failed = new Set(fetchFailed.map((f) => f.alias));
  const dupes = duplicateBaseEntries(sessions, deps.baseCheckouts());
  opts.onPhase?.('scanning', sessions.length);
  const found: CleanupCandidate[] = [];
  let done = 0;
  await pool(sessions, deps.concurrency ?? 6, async (s) => {
    // A duplicate shares its checkout's activity: "recent" says nothing about it.
    const recent = !dupes.has(s.id) && now() - s.lastActiveMs < CLEANUP_MIN_IDLE_MS && s.paths.some((p) => fs.existsSync(p));
    if (!recent && !s.aliases.some((a) => failed.has(a))) {
      const c = await examineWorktree(s, deps, dupes.get(s.id));
      if (c.verdict !== 'keep') found.push(c);
    }
    opts.onProgress?.(++done);
  });
  found.sort((a, b) => a.lastActive.localeCompare(b.lastActive));
  return { candidates: found, fetchFailed, checked: sessions.length };
}

export type CleanupResult = CleanupState['results'][number];

export interface ApplyOptions {
  /** Also remove merged worktrees that have uncommitted changes (they are
   *  lost). Never removes one with commits the main branch doesn't have. */
  force?: boolean;
  onResult?: (r: CleanupResult) => void;
}

/** Carry out the chosen actions, each after a fresh check. */
export async function applyCleanup(
  deps: CleanupDeps,
  items: Array<{ sessionId: string; action: CleanupAction }>,
  opts: ApplyOptions = {},
): Promise<CleanupResult[]> {
  const sessions = await deps.sessions();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const dupes = duplicateBaseEntries(sessions, deps.baseCheckouts());
  const results: CleanupResult[] = [];
  for (const it of items) {
    const s = byId.get(it.sessionId);
    let ok = false;
    let message: string;
    try {
      if (!s) throw new Error('The worktree is gone already.');
      // The scan may be minutes old: decide again on what is there now.
      const fresh = await examineWorktree(s, deps, dupes.get(s.id));
      if (it.action === 'delete') {
        const mergedButDirty = fresh.verdict === 'dirty' && fresh.repos.every((r) => !r.exists || r.merged !== null);
        if (fresh.verdict !== 'merged' && !(opts.force && mergedButDirty)) throw new Error(`Not removed: ${fresh.reason}.`);
      }
      if (it.action === 'forget' && fresh.verdict !== 'gone') throw new Error('Not forgotten: its folder exists again.');
      if (it.action === 'archive' && s.untracked) throw new Error('Not archived: work does not track it.');
      await deps.act(s, it.action);
      ok = true;
      message = it.action === 'delete' ? 'Worktree removed' : it.action === 'archive' ? 'Archived' : 'Forgotten';
    } catch (err) {
      message = (err as Error).message;
    }
    const r = { sessionId: it.sessionId, action: it.action, ok, message };
    results.push(r);
    opts.onResult?.(r);
  }
  return results;
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

/** The web view's background job: scan / apply with progress to poll. */
export function createCleanupJob(deps: CleanupDeps & { onChange?: () => void }): CleanupJob {
  const now = deps.now ?? Date.now;
  let st: CleanupState = { phase: 'idle', done: 0, total: 0, candidates: [], results: [] };
  let running: Promise<void> = Promise.resolve();
  const changed = () => deps.onChange?.();

  const scan = async () => {
    st = { phase: 'fetching', done: 0, total: 0, candidates: [], results: [], startedAt: new Date(now()).toISOString() };
    changed();
    const r = await scanCleanup(deps, {
      onPhase: (phase, total) => {
        st = { ...st, phase, total, done: 0 };
        changed();
      },
      onProgress: (done) => {
        st = { ...st, done };
        if (done % 10 === 0) changed();
      },
    });
    const error = r.fetchFailed.length
      ? `Could not fetch ${r.fetchFailed.map((f) => f.alias).join(', ')}; their worktrees were not checked.`
      : undefined;
    st = { ...st, phase: 'idle', candidates: r.candidates, finishedAt: new Date(now()).toISOString(), ...(error ? { error } : {}) };
    changed();
  };

  const apply = async (items: Array<{ sessionId: string; action: CleanupAction }>) => {
    st = { ...st, phase: 'applying', done: 0, total: items.length, results: [], error: undefined };
    changed();
    const results = await applyCleanup(deps, items, {
      onResult: (r) => {
        st = { ...st, done: st.done + 1, results: [...st.results, r] };
        changed();
      },
    });
    const gone = new Set(results.filter((r) => r.ok).map((r) => r.sessionId));
    st = { ...st, phase: 'idle', candidates: st.candidates.filter((c) => !gone.has(c.sessionId)) };
    changed();
  };

  const busy = () => st.phase !== 'idle';
  const guard = (p: Promise<void>) =>
    p.catch((err: Error) => {
      st = { ...st, phase: 'idle', error: err.message };
      changed();
    });
  return {
    state: () => st,
    scan() {
      if (busy()) return;
      running = guard(scan());
    },
    apply(items) {
      if (busy()) return false;
      running = guard(apply(items));
      return true;
    },
    idle: () => running,
  };
}
