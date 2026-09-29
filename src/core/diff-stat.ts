import fs from 'node:fs';
import path from 'node:path';
import { defaultRunner, type CommandRunner } from './ship.js';
import type { TouchedRepo } from './overlap.js';
import type { WorktreeSession } from './history.js';
import type { DiffStat } from './api-types.js';
import { logSwallowed } from './best-effort.js';

export type { DiffStat } from './api-types.js';

/**
 * `+N −M` per session for the dashboard rows: tracked changes vs HEAD
 * (`git diff HEAD --numstat`) plus untracked files, summed over the
 * session's repos.
 *
 * Computing it runs git per repo, far too slow to do inline for every
 * session on every /api/sessions call (people have hundreds). So reads are
 * served from a cache and never block: a stale or missing entry schedules a
 * background refresh (bounded concurrency), and the caller is told when a
 * value actually changed so it can broadcast once.
 */

export function parseNumstat(out: string): { added: number; deleted: number; files: number } {
  let added = 0;
  let deleted = 0;
  let files = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    // Binary files report "-\t-"; they count as a changed file, 0 lines.
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') deleted += Number(m[2]);
  }
  return { added, deleted, files };
}

export async function computeDiffStat(
  paths: string[],
  run: CommandRunner = defaultRunner,
): Promise<DiffStat | null> {
  return (await computeChanges(paths, [], run)).stat;
}

const lines = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean);

/** A repository's identity across its worktrees: the shared git dir.
 *  Never changes for a path, so it's asked once. */
const commonDirs = new Map<string, string>();
async function repoKeyFor(p: string, run: CommandRunner): Promise<string | null> {
  const known = commonDirs.get(p);
  if (known) return known;
  const r = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], p);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  let key = path.resolve(r.stdout.trim());
  if (process.platform === 'win32') key = key.toLowerCase();
  commonDirs.set(p, key);
  return key;
}

/**
 * The stat (vs HEAD, for the row badge) plus, per repo, every file the
 * branch touches since it forked from origin's default branch — committed,
 * uncommitted and untracked — for the overlap warning (overlap.ts).
 * `names` labels the repos (group sub-repo alias); defaults to the folder.
 */
export async function computeChanges(
  paths: string[],
  names: string[],
  run: CommandRunner = defaultRunner,
): Promise<{ stat: DiffStat | null; touched: TouchedRepo[] }> {
  let total: DiffStat = { added: 0, deleted: 0, files: 0 };
  let any = false;
  const touched: TouchedRepo[] = [];
  for (const [i, p] of paths.entries()) {
    if (!fs.existsSync(p)) continue;
    const numstat = await run('git', ['diff', 'HEAD', '--numstat'], p);
    if (numstat.code !== 0) continue;
    any = true;
    const t = parseNumstat(numstat.stdout);
    const untracked = await run('git', ['ls-files', '--others', '--exclude-standard'], p);
    const newFiles = untracked.code === 0 ? lines(untracked.stdout) : [];
    total = { added: total.added + t.added, deleted: total.deleted + t.deleted, files: total.files + t.files + newFiles.length };

    const repoKey = await repoKeyFor(p, run);
    if (!repoKey) continue;
    // Since the fork point; with no origin default branch known, since HEAD.
    const mb = await run('git', ['merge-base', 'HEAD', 'origin/HEAD'], p);
    const since = mb.code === 0 && /^[0-9a-f]{7,64}$/.test(mb.stdout.trim()) ? mb.stdout.trim() : 'HEAD';
    const changed = await run('git', ['diff', '--name-only', since], p);
    const files = new Set([...(changed.code === 0 ? lines(changed.stdout) : []), ...newFiles]);
    if (files.size) touched.push({ repoKey, name: names[i] ?? path.basename(p), files: [...files].sort() });
  }
  return { stat: any ? total : null, touched };
}

interface Entry {
  stat: DiffStat | null;
  touched: TouchedRepo[];
  at: number;
  inFlight: boolean;
  /** Bumped by invalidate(): a refresh that started before the bump
   *  computed from files that have since changed. */
  gen: number;
}

export interface DiffStatCacheOptions {
  ttlMs?: number;
  concurrency?: number;
  run?: CommandRunner;
  /** Called (debounced by the caller as it likes) when a value changed. */
  onChange?: () => void;
  now?: () => number;
}

export class DiffStatCache {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Array<{ id: string; paths: string[]; names: string[]; gen: number }> = [];
  private running = 0;
  private readonly ttlMs: number;
  private readonly concurrency: number;
  private readonly run: CommandRunner;
  private readonly now: () => number;

  constructor(private readonly opts: DiffStatCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 20_000;
    this.concurrency = opts.concurrency ?? 4;
    this.run = opts.run ?? defaultRunner;
    this.now = opts.now ?? Date.now;
  }

  /** Last known value (possibly stale or null); schedules a refresh when
   *  it's missing or older than the TTL. Never blocks. */
  get(id: string, paths: string[], names: string[] = []): DiffStat | null {
    const e = this.entries.get(id);
    if (!e || (!e.inFlight && this.now() - e.at > this.ttlMs)) this.schedule(id, paths, names);
    return e?.stat ?? null;
  }

  /** Last known files per repo (for overlaps); [] until computed. Call
   *  after get(), which keeps it fresh. */
  touched(id: string): TouchedRepo[] {
    return this.entries.get(id)?.touched ?? [];
  }

  /** Force a refresh soon (a file changed in that worktree). */
  invalidate(id: string): void {
    const e = this.entries.get(id);
    if (e) {
      e.at = 0;
      e.gen++;
    }
  }

  /** Resolves when the queue is drained — for tests. */
  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private schedule(id: string, paths: string[], names: string[]): void {
    const e = this.entries.get(id) ?? { stat: null, touched: [], at: 0, inFlight: false, gen: 0 };
    if (e.inFlight) return;
    e.inFlight = true;
    this.entries.set(id, e);
    this.queue.push({ id, paths, names, gen: e.gen });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      computeChanges(job.paths, job.names, this.run)
        .catch((err) => {
          logSwallowed(`diff stat for ${job.id}`, err);
          return { stat: null, touched: [] as TouchedRepo[] };
        })
        .then(({ stat, touched }) => {
          const e = this.entries.get(job.id)!;
          const changed =
            JSON.stringify(e.stat) !== JSON.stringify(stat) || JSON.stringify(e.touched) !== JSON.stringify(touched);
          e.stat = stat;
          e.touched = touched;
          // Invalidated while computing: show this value, but keep it stale
          // so the next read recomputes (instead of trusting it for a TTL).
          e.at = e.gen === job.gen ? this.now() : 0;
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

/** Which sessions are worth computing for: not archived, touched in the
 *  last two weeks or reporting a status. Keeps hundreds of old worktrees
 *  from costing git calls on every refresh. */
export function wantsDiffStat(s: WorktreeSession, hasStatus: boolean, now = Date.now()): boolean {
  if (s.archivedAt) return false;
  if (hasStatus) return true;
  const last = Date.parse(s.lastAccessedAt) || 0;
  return now - last < 14 * 24 * 60 * 60_000;
}
